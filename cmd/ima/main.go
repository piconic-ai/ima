// Command ima shares a local Markdown file and co-edits it with others in their browser.
package main

import (
	"context"
	"fmt"
	"io"
	"os"
	"os/signal"
	"os/user"
	"path/filepath"
	"runtime/debug"
	"sync"
	"syscall"

	"github.com/piconic-ai/ima/internal/clipboard"
	"github.com/piconic-ai/ima/internal/protocol"
	"github.com/piconic-ai/ima/internal/session"
	"golang.org/x/term"
)

// version is set at build time with -ldflags "-X main.version=...".
var version = ""

// getVersion falls back to the module version, which `go install ...@vX.Y.Z` records.
func getVersion() string {
	if version != "" {
		return version
	}
	if info, ok := debug.ReadBuildInfo(); ok && info.Main.Version != "" && info.Main.Version != "(devel)" {
		return info.Main.Version
	}
	return "dev"
}

const defaultServer = "https://ima.piconic.ai"

const usage = `Usage: ima <file>

Share a local Markdown file and co-edit it with others in their browser.
Edits are written back to the file. Press Ctrl+C to finish.

Environment:
  IMA_SERVER  ima server URL (default: ` + defaultServer + `)`

func main() {
	os.Exit(run(os.Args[1:], os.Stdout, os.Stderr))
}

func run(args []string, stdout, stderr io.Writer) int {
	if len(args) == 1 && (args[0] == "-h" || args[0] == "--help") {
		fmt.Fprintln(stdout, usage)
		return 0
	}
	if len(args) == 1 && (args[0] == "-v" || args[0] == "--version") {
		fmt.Fprintln(stdout, getVersion())
		return 0
	}
	if len(args) != 1 || args[0] == "" {
		fmt.Fprintln(stderr, usage)
		return 2
	}
	arg := args[0]
	file, err := filepath.Abs(arg)
	if err != nil {
		fmt.Fprintln(stderr, "ima:", err)
		return 1
	}
	if st, err := os.Stat(file); err != nil || st.IsDir() {
		fmt.Fprintf(stderr, "ima: no such file: %s\n", arg)
		return 1
	}

	server := os.Getenv("IMA_SERVER")
	if server == "" {
		server = defaultServer
	}
	status := &statusLine{out: stdout, tty: isTerminal(stdout), status: protocol.StatusConnecting}

	signals := make(chan os.Signal, 2)
	signal.Notify(signals, os.Interrupt, syscall.SIGTERM)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() {
		<-signals
		cancel()
	}()

	s, err := session.Start(ctx, session.Options{
		File:     file,
		Server:   server,
		Name:     username(),
		Watch:    true,
		OnStatus: status.setStatus,
		OnPeers:  status.setPeers,
		OnError: func(err error) {
			if os.Getenv("IMA_DEBUG") != "" {
				fmt.Fprintln(stderr, "\nima:", err)
			}
		},
	})
	if err != nil {
		fmt.Fprintln(stderr, "ima:", err)
		return 1
	}

	copied := clipboard.Copy(s.URL)
	fmt.Fprintf(stdout, "Sharing %s\n\n  %s\n\n", arg, s.URL)
	if copied {
		fmt.Fprint(stdout, "  (copied to clipboard)\n\n")
	}
	status.start()

	<-ctx.Done()
	// A second signal gives up on saving.
	go func() {
		<-signals
		os.Exit(130)
	}()
	status.stop()
	fmt.Fprintln(stdout, "Saving and closing the room…")
	if err := s.Stop(); err != nil {
		fmt.Fprintf(stderr, "ima: could not save %s: %v\n", arg, err)
		return 1
	}
	fmt.Fprintf(stdout, "Saved %s\n", arg)
	return 0
}

// statusLine shows the connection state and how many others are in the room.
type statusLine struct {
	out io.Writer
	tty bool

	mu      sync.Mutex
	ready   bool
	status  protocol.Status
	peers   int
	stopped bool
}

func (l *statusLine) setStatus(s protocol.Status) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.status = s
	l.render()
}

func (l *statusLine) setPeers(n int) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if n == l.peers {
		return
	}
	l.peers = n
	l.render()
}

func (l *statusLine) start() {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.ready = true
	l.render()
}

func (l *statusLine) stop() {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.stopped = true
	if l.tty {
		fmt.Fprintln(l.out)
	}
}

func (l *statusLine) render() {
	if !l.ready || l.stopped {
		return
	}
	who := "waiting for others"
	if l.peers == 1 {
		who = "1 other here"
	} else if l.peers > 1 {
		who = fmt.Sprintf("%d others here", l.peers)
	}
	dot := "○"
	if l.status == protocol.StatusConnected {
		dot = "●"
	}
	line := fmt.Sprintf("%s %s · %s", dot, l.status, who)
	if l.tty {
		fmt.Fprintf(l.out, "\r\x1b[2K  %s", line)
	} else {
		fmt.Fprintln(l.out, line)
	}
}

func isTerminal(w io.Writer) bool {
	f, ok := w.(*os.File)
	return ok && term.IsTerminal(int(f.Fd()))
}

func username() string {
	u, err := user.Current()
	if err != nil {
		return ""
	}
	return u.Username
}
