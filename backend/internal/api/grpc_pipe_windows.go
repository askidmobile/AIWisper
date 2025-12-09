//go:build windows

package api

import (
	"net"

	"github.com/Microsoft/go-winio"
)

func listenPipe(addr string) (net.Listener, error) {
	return winio.ListenPipe(addr, nil)
}
