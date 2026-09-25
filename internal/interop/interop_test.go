// Package interop checks the Go host against the web client's JavaScript RoomClient.
package interop

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/piconic-ai/ima/internal/protocol"
	"github.com/piconic-ai/ima/internal/protocol/prototest"
	"github.com/piconic-ai/ima/internal/session"
)

const roomID = "AAAAAAAAAAAAAAAAAAAAAA"

// newServer stands in for the Worker: it creates rooms and relays frames between sockets.
func newServer(t *testing.T) *httptest.Server {
	var mu sync.Mutex
	conns := map[*websocket.Conn]bool{}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/rooms", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(w).Encode(map[string]string{"id": roomID, "hostToken": "host-token"})
	})
	mux.HandleFunc("GET /api/rooms/{id}/ws", func(w http.ResponseWriter, r *http.Request) {
		c, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		c.SetReadLimit(-1)
		mu.Lock()
		conns[c] = true
		mu.Unlock()
		defer func() {
			mu.Lock()
			delete(conns, c)
			mu.Unlock()
		}()
		for {
			typ, data, err := c.Read(context.Background())
			if err != nil {
				return
			}
			mu.Lock()
			for peer := range conns {
				if peer != c {
					_ = peer.Write(context.Background(), typ, data)
				}
			}
			mu.Unlock()
		}
	})
	s := httptest.NewServer(mux)
	t.Cleanup(s.Close)
	return s
}

// protocolDir returns packages/protocol, or skips the test when its
// dependencies or Node.js are missing (unless IMA_INTEROP requires it).
func protocolDir(t *testing.T) string {
	dir, err := filepath.Abs("../../packages/protocol")
	if err != nil {
		t.Fatal(err)
	}
	_, nodeErr := exec.LookPath("node")
	_, depsErr := os.Stat(filepath.Join(dir, "node_modules", "yjs"))
	if nodeErr != nil || depsErr != nil {
		if os.Getenv("IMA_INTEROP") != "" {
			t.Fatalf("node or packages/protocol dependencies missing (run pnpm install)")
		}
		t.Skip("needs node and pnpm install")
	}
	return dir
}

func TestGoHostWithJavaScriptGuest(t *testing.T) {
	dir := protocolDir(t)
	server := newServer(t)
	file := filepath.Join(t.TempDir(), "notes.md")
	if err := os.WriteFile(file, []byte("こんにちは🌏 world\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	s, err := session.Start(context.Background(), session.Options{
		File:       file,
		Server:     server.URL,
		WriteDelay: 20 * time.Millisecond,
		Watch:      true,
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(s.Stop)
	prototest.WaitFor(t, 5*time.Second, func() bool { return s.Client.Status() == protocol.StatusConnected }, "host connected")

	share, _ := url.Parse(s.URL)
	wsURL := "ws" + strings.TrimPrefix(server.URL, "http") + "/api/rooms/" + roomID + "/ws"
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	guest := exec.CommandContext(ctx, "node", "testdata/guest.mjs", dir, wsURL, share.Fragment)
	var stdout, stderr strings.Builder
	guest.Stdout = &stdout
	guest.Stderr = &stderr
	if err := guest.Start(); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { done <- guest.Wait() }()

	read := func() string {
		b, _ := os.ReadFile(file)
		return string(b)
	}
	const edited = "こにちは🌏[X] world\n"
	prototest.WaitFor(t, 10*time.Second, func() bool { return read() == edited }, "the guest's edit on disk")

	const final = edited + "from file 🐹\n"
	if err := os.WriteFile(file, []byte(final), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := <-done; err != nil {
		t.Fatalf("guest failed: %v\n%s", err, stderr.String())
	}
	var got string
	if err := json.Unmarshal([]byte(stdout.String()), &got); err != nil || got != final {
		t.Fatalf("guest ended with %q (%v)\n%s", stdout.String(), err, stderr.String())
	}
	s.Stop()
	if read() != final {
		t.Fatalf("file = %q", read())
	}
}
