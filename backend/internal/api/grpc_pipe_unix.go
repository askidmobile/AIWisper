//go:build !windows

package api

import (
	"fmt"
	"net"
)

func listenPipe(addr string) (net.Listener, error) {
	return nil, fmt.Errorf("named pipes are supported only on Windows (requested %s)", addr)
}
