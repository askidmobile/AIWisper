package api

import (
	"encoding/json"
	"errors"
	"log"
	"net"
	"os"
	"runtime"
	"strings"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/encoding"
	"google.golang.org/grpc/status"
)

// jsonCodec позволяет использовать gRPC с JSON-пейлоадом вместо protobuf,
// чтобы переиспользовать существующую структуру Message без генерации кодеков.
type jsonCodec struct{}

func (jsonCodec) Name() string { return "json" }
func (jsonCodec) Marshal(v any) ([]byte, error) {
	return json.Marshal(v)
}
func (jsonCodec) Unmarshal(data []byte, v any) error {
	return json.Unmarshal(data, v)
}

func init() {
	encoding.RegisterCodec(jsonCodec{})
}

// ControlServer описывает bidirectional stream, аналогичный WebSocket каналу.
type ControlServer interface {
	Stream(Control_StreamServer) error
}

type UnimplementedControlServer struct{}

func (UnimplementedControlServer) Stream(Control_StreamServer) error {
	return status.Errorf(codes.Unimplemented, "method Stream not implemented")
}

type Control_StreamServer interface {
	Send(*Message) error
	Recv() (*Message, error)
	grpc.ServerStream
}

type controlStreamServer struct {
	grpc.ServerStream
}

func (x *controlStreamServer) Send(m *Message) error {
	return x.ServerStream.SendMsg(m)
}

func (x *controlStreamServer) Recv() (*Message, error) {
	m := new(Message)
	if err := x.ServerStream.RecvMsg(m); err != nil {
		return nil, err
	}
	return m, nil
}

func _Control_Stream_Handler(srv interface{}, stream grpc.ServerStream) error {
	return srv.(ControlServer).Stream(&controlStreamServer{stream})
}

var _Control_serviceDesc = grpc.ServiceDesc{
	ServiceName: "aiwisper.Control",
	HandlerType: (*ControlServer)(nil),
	Streams: []grpc.StreamDesc{
		{
			StreamName:    "Stream",
			Handler:       _Control_Stream_Handler,
			ServerStreams: true,
			ClientStreams: true,
		},
	},
	Metadata: "internal/api/control.proto",
}

func RegisterControlServer(s *grpc.Server, srv ControlServer) {
	s.RegisterService(&_Control_serviceDesc, srv)
}

func (s *Server) startGRPCServer() {
	addr := s.Config.GRPCAddr
	if addr == "" {
		if runtime.GOOS == "windows" {
			addr = "npipe:\\\\.\\pipe\\aiwisper-grpc"
		} else {
			addr = "unix:///tmp/aiwisper-grpc.sock"
		}
	}

	lis, err := listenGRPC(addr)
	if err != nil {
		log.Printf("Failed to start gRPC listener (%s): %v", addr, err)
		return
	}

	server := grpc.NewServer(
		grpc.Creds(insecure.NewCredentials()),
		grpc.ForceServerCodec(jsonCodec{}),
	)
	RegisterControlServer(server, s)

	log.Printf("gRPC listening on %s", addr)
	if err := server.Serve(lis); err != nil {
		log.Printf("gRPC server stopped: %v", err)
	}
}

func listenGRPC(addr string) (net.Listener, error) {
	switch {
	case strings.HasPrefix(addr, "unix:"):
		socketPath := strings.TrimPrefix(addr, "unix:")
		if err := removeIfExists(socketPath); err != nil {
			return nil, err
		}
		return net.Listen("unix", socketPath)
	case strings.HasPrefix(addr, "npipe:"):
		pipePath := strings.TrimPrefix(addr, "npipe:")
		return listenPipe(pipePath)
	default:
		// Fallback для TCP (не основной кейс)
		return net.Listen("tcp", addr)
	}
}

func removeIfExists(path string) error {
	if path == "" {
		return errors.New("empty socket path")
	}
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		return err
	}
	return nil
}
