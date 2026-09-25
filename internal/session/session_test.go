package session

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/piconic-ai/ima/internal/filewriter"
	"github.com/piconic-ai/ima/internal/protocol"
	"github.com/piconic-ai/ima/internal/protocol/prototest"
	"github.com/reearth/ygo/awareness"
	"github.com/reearth/ygo/crdt"
)

const wait = 3 * time.Second

type fixture struct {
	file     string
	relay    *prototest.Relay
	server   *httptest.Server
	requests []string
	session  *Session
}

type setupOpts struct {
	watch      bool
	writeDelay time.Duration
}

func setup(t *testing.T, content string, o setupOpts) *fixture {
	t.Helper()
	f := &fixture{relay: prototest.NewRelay(true)}
	f.file = filepath.Join(t.TempDir(), "notes.md")
	if err := os.WriteFile(f.file, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	var mu sync.Mutex
	f.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		f.requests = append(f.requests, r.Method+" "+r.URL.String())
		mu.Unlock()
		w.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(w).Encode(map[string]string{"id": "AAAAAAAAAAAAAAAAAAAAAA", "hostToken": "host-token"})
	}))
	t.Cleanup(f.server.Close)
	if o.writeDelay == 0 {
		o.writeDelay = 20 * time.Millisecond
	}
	s, err := Start(context.Background(), Options{
		File:       f.file,
		Server:     f.server.URL + "/",
		WriteDelay: o.writeDelay,
		Watch:      o.watch,
		Dial:       f.relay.Dial,
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Stop() })
	f.session = s
	// Guests are turned away until the host is in the room.
	prototest.WaitFor(t, wait, func() bool { return s.Client.Status() == protocol.StatusConnected }, "host connected")
	return f
}

type guest struct {
	*protocol.Client
	doc  *crdt.Doc
	text *crdt.YText
	aw   *awareness.Awareness
}

func (g *guest) String() string { return g.text.ToString() }

func (g *guest) insert(index int, s string) {
	g.doc.Transact(func(txn *crdt.Transaction) { g.text.Insert(txn, index, s, nil) })
}

func joinAsGuest(t *testing.T, relay *prototest.Relay, shareURL string) *guest {
	t.Helper()
	u, err := url.Parse(shareURL)
	if err != nil {
		t.Fatal(err)
	}
	key, err := protocol.DecodeKey(u.Fragment)
	if err != nil {
		t.Fatal(err)
	}
	doc := crdt.New()
	aw := awareness.New(uint64(doc.ClientID()))
	aw.SetLocalState(map[string]any{}) // like a JavaScript Awareness starts
	c, err := protocol.NewClient(protocol.ClientOptions{
		URL: "ws://guest", Key: key, Doc: doc, Awareness: aw, Dial: relay.Dial,
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(c.Destroy)
	c.Connect()
	return &guest{Client: c, doc: doc, text: doc.GetText("content"), aw: aw}
}

func readFile(t *testing.T, path string) string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func TestShareURLKeyNeverReachesServer(t *testing.T) {
	f := setup(t, "# hi", setupOpts{})
	u, _ := url.Parse(f.session.URL)
	if origin := u.Scheme + "://" + u.Host; origin != f.server.URL {
		t.Fatalf("origin = %q", origin)
	}
	if u.Path != "/r/AAAAAAAAAAAAAAAAAAAAAA" {
		t.Fatalf("path = %q", u.Path)
	}
	key := u.Fragment
	if len(key) != 43 {
		t.Fatalf("key = %q", key)
	}
	if len(f.requests) != 1 || f.requests[0] != "POST /api/rooms" {
		t.Fatalf("requests = %v", f.requests)
	}
	prototest.WaitFor(t, wait, func() bool { return len(f.relay.URLs()) == 1 }, "dial")
	wsURL := "ws" + strings.TrimPrefix(f.server.URL, "http") + "/api/rooms/AAAAAAAAAAAAAAAAAAAAAA/ws"
	if got := f.relay.URLs()[0]; got != wsURL {
		t.Fatalf("ws url = %q", got)
	}
	header := f.relay.Headers()[0]
	if got := header.Get("Authorization"); got != "Bearer host-token" {
		t.Fatalf("Authorization = %q", got)
	}
	for _, s := range append(append(f.requests, f.relay.URLs()...), header.Get("Authorization")) {
		if strings.Contains(s, key) {
			t.Fatalf("key leaked in %q", s)
		}
	}
}

func TestFailsWhenRoomCannotBeCreated(t *testing.T) {
	file := filepath.Join(t.TempDir(), "notes.md")
	_ = os.WriteFile(file, []byte("x"), 0o644)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "nope", http.StatusServiceUnavailable)
	}))
	defer server.Close()
	_, err := Start(context.Background(), Options{File: file, Server: server.URL})
	if err == nil || !strings.Contains(err.Error(), "503") {
		t.Fatalf("err = %v", err)
	}
}

func TestServesFileAndWritesBackGuestEdits(t *testing.T) {
	f := setup(t, "# notes\n", setupOpts{})
	g := joinAsGuest(t, f.relay, f.session.URL)
	prototest.WaitFor(t, wait, func() bool { return g.String() == "# notes\n" }, "guest to sync")
	g.insert(len("# notes\n"), "- from guest\n")
	prototest.WaitFor(t, wait, func() bool { return readFile(t, f.file) == "# notes\n- from guest\n" }, "write back")
}

func TestWritesFinalStateOnStop(t *testing.T) {
	f := setup(t, "a", setupOpts{writeDelay: time.Minute})
	g := joinAsGuest(t, f.relay, f.session.URL)
	prototest.WaitFor(t, wait, func() bool { return g.String() == "a" }, "guest to sync")
	g.insert(1, "b")
	prototest.WaitFor(t, wait, func() bool { return f.session.Text.ToString() == "ab" }, "host to see the edit")
	if err := f.session.Stop(); err != nil {
		t.Fatal(err)
	}
	if got := readFile(t, f.file); got != "ab" {
		t.Fatalf("content = %q", got)
	}
}

func TestAnnouncesItselfAsHost(t *testing.T) {
	f := setup(t, "", setupOpts{})
	g := joinAsGuest(t, f.relay, f.session.URL)
	prototest.WaitFor(t, wait, func() bool {
		for _, s := range g.aw.GetStates() {
			if s.State["role"] == "host" && s.State["file"] == "notes.md" {
				return true
			}
		}
		return false
	}, "host awareness")
}

func TestStreamsExternalEditsToGuests(t *testing.T) {
	f := setup(t, "# notes\n", setupOpts{watch: true})
	g := joinAsGuest(t, f.relay, f.session.URL)
	prototest.WaitFor(t, wait, func() bool { return g.String() == "# notes\n" }, "guest to sync")
	if err := os.WriteFile(f.file, []byte("# notes\n- edited in vim\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	prototest.WaitFor(t, wait, func() bool { return g.String() == "# notes\n- edited in vim\n" }, "external edit")
}

func TestMergesExternalEditWithConcurrentRemoteEdit(t *testing.T) {
	f := setup(t, "one\ntwo\n", setupOpts{watch: true, writeDelay: time.Second})
	g := joinAsGuest(t, f.relay, f.session.URL)
	prototest.WaitFor(t, wait, func() bool { return g.String() == "one\ntwo\n" }, "guest to sync")
	// The guest edits, and before it is written back the host edits the file.
	g.insert(0, "zero\n")
	prototest.WaitFor(t, wait, func() bool { return strings.Contains(f.session.Text.ToString(), "zero") }, "host to see the edit")
	if err := os.WriteFile(f.file, []byte("one\ntwo\nthree\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	const merged = "zero\none\ntwo\nthree\n"
	prototest.WaitFor(t, wait, func() bool { return g.String() == merged }, "merged doc")
	prototest.WaitFor(t, wait, func() bool { return readFile(t, f.file) == merged }, "merged file")
	g.Destroy()
	if err := f.session.Stop(); err != nil {
		t.Fatal(err)
	}
	if got := readFile(t, f.file); got != merged {
		t.Fatalf("content = %q", got)
	}
}

func TestNoLoopBetweenWriteBackAndWatch(t *testing.T) {
	f := setup(t, "a", setupOpts{watch: true})
	g := joinAsGuest(t, f.relay, f.session.URL)
	prototest.WaitFor(t, wait, func() bool { return g.String() == "a" }, "guest to sync")
	var mu sync.Mutex
	var origins []any
	f.session.Doc.OnUpdate(func(_ []byte, origin any) { mu.Lock(); origins = append(origins, origin); mu.Unlock() })
	g.insert(1, "b")
	prototest.WaitFor(t, wait, func() bool { return f.session.Writer.LastWritten() == "ab" }, "write back")
	time.Sleep(300 * time.Millisecond)
	mu.Lock()
	defer mu.Unlock()
	if len(origins) != 1 {
		t.Fatalf("updates = %v", origins)
	}
}

func TestClosesRoomForGuestsOnStop(t *testing.T) {
	f := setup(t, "bye", setupOpts{})
	g := joinAsGuest(t, f.relay, f.session.URL)
	prototest.WaitFor(t, wait, func() bool { return g.String() == "bye" }, "guest to sync")
	if err := f.session.Stop(); err != nil {
		t.Fatal(err)
	}
	prototest.WaitFor(t, wait, func() bool { return g.Status() == protocol.StatusClosed }, "guest closed")
}

func TestStopReportsFailedFinalWrite(t *testing.T) {
	f := setup(t, "a", setupOpts{writeDelay: time.Minute})
	g := joinAsGuest(t, f.relay, f.session.URL)
	prototest.WaitFor(t, wait, func() bool { return g.String() == "a" }, "guest to sync")
	g.insert(1, "b")
	prototest.WaitFor(t, wait, func() bool { return f.session.Text.ToString() == "ab" }, "host to see the edit")
	// The atomic write needs a temp file next to the target.
	dir := filepath.Dir(f.file)
	if err := os.Chmod(dir, 0o555); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(dir, 0o755) })
	if err := f.session.Stop(); err == nil {
		t.Fatal("Stop should report the failed write")
	}
}

func TestReadSettledGivesUpOnAFileThatKeepsChanging(t *testing.T) {
	file := filepath.Join(t.TempDir(), "notes.md")
	done := make(chan struct{})
	defer close(done)
	go func() {
		for i := 0; ; i++ {
			select {
			case <-done:
				return
			default:
			}
			_ = filewriter.WriteAtomic(file, strconv.Itoa(i))
			time.Sleep(3 * time.Millisecond)
		}
	}()
	if got, ok := readSettled(file); ok {
		t.Fatalf("readSettled = %q, want !ok", got)
	}
}
