package api

import (
	"context"
	"encoding/json"
	"net"
	"testing"
	"time"

	"aiwisper/ai"
	"aiwisper/audio"
	"aiwisper/internal/config"
	"aiwisper/internal/service"
	"aiwisper/models"
	"aiwisper/session"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
)

// jsonClient is a lightweight gRPC JSON client for the Control stream.
type jsonClient struct {
	conn   *grpc.ClientConn
	stream grpc.ClientStream
}

func newJSONClient(t *testing.T, addr string) *jsonClient {
	t.Helper()

	conn, err := grpc.Dial(
		addr,
		grpc.WithTransportCredentials(insecure.NewCredentials()),
		grpc.WithDefaultCallOptions(grpc.ForceCodec(jsonCodec{})),
		grpc.WithContextDialer(func(ctx context.Context, addr string) (net.Conn, error) {
			// Support unix:/path format
			if len(addr) > 5 && addr[:5] == "unix:" {
				return net.DialTimeout("unix", addr[5:], 3*time.Second)
			}
			return net.DialTimeout("tcp", addr, 3*time.Second)
		}),
	)
	if err != nil {
		t.Fatalf("dial grpc: %v", err)
	}

	stream, err := conn.NewStream(context.Background(), &_Control_serviceDesc.Streams[0], "/aiwisper.Control/Stream")
	if err != nil {
		t.Fatalf("open stream: %v", err)
	}

	return &jsonClient{conn: conn, stream: stream}
}

func (c *jsonClient) send(msg Message) error {
	raw, err := json.Marshal(msg)
	if err != nil {
		return err
	}
	// Send as generic interface{} so ForceCodec(jsonCodec{}) kicks in on server
	var any interface{}
	if err := json.Unmarshal(raw, &any); err != nil {
		return err
	}
	return c.stream.SendMsg(any)
}

func (c *jsonClient) recv(timeout time.Duration) (Message, error) {
	var msg Message
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	recvDone := make(chan error, 1)
	go func() { recvDone <- c.stream.RecvMsg(&msg) }()
	select {
	case err := <-recvDone:
		return msg, err
	case <-ctx.Done():
		return Message{}, ctx.Err()
	}
}

func (c *jsonClient) close() {
	_ = c.stream.CloseSend()
	_ = c.conn.Close()
}

// startTestServer запускает минимальный сервер с unix сокетом.
func startTestServer(t *testing.T, socketPath string) *Server {
	t.Helper()

	cfg := &config.Config{
		ModelPath: "ggml-base.bin",
		DataDir:   "data/sessions",
		ModelsDir: "data/models",
		Port:      "0",
		GRPCAddr:  "unix:" + socketPath,
	}

	// Инициализация зависимостей
	sessMgr, err := session.NewManager(cfg.DataDir)
	if err != nil {
		t.Fatalf("session manager: %v", err)
	}
	modelMgr, err := models.NewManager(cfg.ModelsDir)
	if err != nil {
		t.Fatalf("model manager: %v", err)
	}
	engineMgr := ai.NewEngineManager(modelMgr)
	capture, err := audio.NewCapture()
	if err != nil {
		t.Fatalf("capture init: %v", err)
	}
	transcriptionService := service.NewTranscriptionService(sessMgr, engineMgr)
	recordingService := service.NewRecordingService(sessMgr, capture)
	llmService := service.NewLLMService()

	s := NewServer(cfg, sessMgr, engineMgr, modelMgr, capture, transcriptionService, recordingService, llmService)

	go s.startGRPCServer()
	time.Sleep(300 * time.Millisecond) // дать сокету создаться
	return s
}

func TestControlStream_SessionsAndModels(t *testing.T) {
	socket := "/tmp/aiwisper-test.sock"
	// sanity check path syntax
	_, _ = net.Dial("unix", socket)

	s := startTestServer(t, socket)
	t.Cleanup(func() { _, _ = net.Dial("unix", socket) })
	// В тестовом сценарии HTTP сервер не нужен.

	client := newJSONClient(t, s.Config.GRPCAddr)
	defer client.close()

	if err := client.send(Message{Type: "get_sessions"}); err != nil {
		t.Fatalf("send get_sessions: %v", err)
	}
	if err := client.send(Message{Type: "get_models"}); err != nil {
		t.Fatalf("send get_models: %v", err)
	}

	gotSessions := false
	gotModels := false
	timeout := time.After(2 * time.Second)

	for !(gotSessions && gotModels) {
		select {
		case <-timeout:
			t.Fatalf("timeout waiting for responses: sessions=%v models=%v", gotSessions, gotModels)
		default:
			msg, err := client.recv(2 * time.Second)
			if err != nil {
				t.Fatalf("recv: %v", err)
			}
			switch msg.Type {
			case "sessions_list":
				gotSessions = true
			case "models_list":
				gotModels = true
			}
		}
	}
}
