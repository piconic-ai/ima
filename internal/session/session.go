// Package session shares a local file in an ima room.
package session

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/fsnotify/fsnotify"
	"github.com/piconic-ai/ima/internal/filewriter"
	"github.com/piconic-ai/ima/internal/merge"
	"github.com/piconic-ai/ima/internal/protocol"
	"github.com/reearth/ygo/awareness"
	"github.com/reearth/ygo/crdt"
)

type Options struct {
	File string
	// Server is the base URL of the ima server, e.g. https://ima.piconic.ai
	Server     string
	Name       string
	WriteDelay time.Duration
	// Watch streams edits made to the file outside ima into the room.
	Watch      bool
	HTTPClient *http.Client
	Dial       protocol.Dialer
	OnStatus   func(protocol.Status)
	// OnPeers is called with the number of other people in the room.
	OnPeers func(int)
	OnError func(error)
}

type Session struct {
	// URL is the share URL. Its fragment holds the key and must never be sent to the server.
	URL    string
	Doc    *crdt.Doc
	Text   *crdt.YText
	Client *protocol.Client
	Writer *filewriter.Writer

	file      string
	awareness *awareness.Awareness
	watcher   *fsnotify.Watcher
	watchDone chan struct{}
	stopAlive func()
	onError   func(error)

	mu        sync.Mutex
	readTimer *time.Timer
	stopped   bool
	stopOnce  sync.Once
	stopErr   error

	// syncing serializes syncs from disk, and lets Stop wait out one in flight.
	syncing sync.Mutex

	// Test seams, called during Stop.
	beforeDestroy    func()
	beforeFinalWrite func(attempt int)
}

// fileOrigin tags changes merged in from the file.
const fileOrigin = "file"

// Awareness timings of y-protocols: peers that stay silent for outdatedTimeout
// are dropped, so renew our state well before that.
const (
	outdatedTimeout = 30 * time.Second
	renewInterval   = outdatedTimeout / 2
)

func Start(ctx context.Context, opts Options) (*Session, error) {
	onError := opts.OnError
	if onError == nil {
		onError = func(error) {}
	}
	content, ok := filewriter.ReadFile(opts.File)
	if !ok {
		return nil, fmt.Errorf("cannot read %s", opts.File)
	}

	server := strings.TrimRight(opts.Server, "/")
	room, err := createRoom(ctx, opts.HTTPClient, server)
	if err != nil {
		return nil, err
	}
	key := protocol.GenerateKey()
	rawKey, err := protocol.DecodeKey(key)
	if err != nil {
		return nil, err
	}
	wsURL := "ws" + strings.TrimPrefix(server, "http") + "/api/rooms/" + room.ID + "/ws"

	doc := crdt.New()
	text := doc.GetText("content")
	doc.Transact(func(txn *crdt.Transaction) { text.Insert(txn, 0, content, nil) })
	aw := awareness.New(uint64(doc.ClientID()))
	name := opts.Name
	if name == "" {
		name = "host"
	}
	aw.SetLocalState(map[string]any{"role": "host", "name": name, "file": filepath.Base(opts.File)})

	s := &Session{
		URL:       server + "/r/" + room.ID + "#" + key,
		Doc:       doc,
		Text:      text,
		file:      opts.File,
		awareness: aw,
		onError:   onError,
	}
	s.Writer = filewriter.New(opts.File, content, filewriter.Options{
		Delay:            opts.WriteDelay,
		OnError:          onError,
		OnExternalChange: s.scheduleSyncFromDisk,
	})
	s.Client, err = protocol.NewClient(protocol.ClientOptions{
		URL:       wsURL,
		Key:       rawKey,
		Doc:       doc,
		Awareness: aw,
		// Marks us as the host: the room closes for everyone once we leave.
		Header:   http.Header{"Authorization": {"Bearer " + room.HostToken}},
		Dial:     opts.Dial,
		OnStatus: opts.OnStatus,
		OnError:  onError,
	})
	if err != nil {
		return nil, err
	}

	doc.OnUpdate(func(_ []byte, origin any) {
		if origin == s.Client {
			s.Writer.Schedule(s.Text.ToString())
		}
	})
	aw.OnChange(func(awareness.ChangeEvent) {
		if opts.OnPeers == nil {
			return
		}
		others := 0
		for id := range aw.GetStates() {
			if id != aw.ClientID() {
				others++
			}
		}
		opts.OnPeers(others)
	})
	s.stopAlive = keepAlive(aw)
	s.Client.Connect()

	if opts.Watch {
		if err := s.watch(); err != nil {
			_ = s.Stop()
			return nil, err
		}
	}
	return s, nil
}

type room struct {
	ID        string `json:"id"`
	HostToken string `json:"hostToken"`
}

func createRoom(ctx context.Context, client *http.Client, server string) (*room, error) {
	if client == nil {
		client = http.DefaultClient
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, server+"/api/rooms", bytes.NewReader(nil))
	if err != nil {
		return nil, err
	}
	res, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("failed to create a room: %w", err)
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode > 299 {
		return nil, fmt.Errorf("failed to create a room: %s", res.Status)
	}
	var r room
	if err := json.NewDecoder(res.Body).Decode(&r); err != nil || r.ID == "" || r.HostToken == "" {
		return nil, fmt.Errorf("failed to create a room: unexpected response")
	}
	return &r, nil
}

// keepAlive renews our awareness state and drops peers that went silent, as the
// JavaScript Awareness does on its own.
func keepAlive(aw *awareness.Awareness) func() {
	stopExpiry := aw.StartAutoExpiry(outdatedTimeout)
	ticker := time.NewTicker(renewInterval)
	done := make(chan struct{})
	go func() {
		for {
			select {
			case <-ticker.C:
				aw.Heartbeat()
			case <-done:
				return
			}
		}
	}()
	return func() {
		ticker.Stop()
		close(done)
		stopExpiry()
	}
}

// Watch the directory rather than the file: editors often save by renaming a
// new file over the old one, which would orphan a watch on the file itself.
func (s *Session) watch() error {
	w, err := fsnotify.NewWatcher()
	if err != nil {
		return err
	}
	if err := w.Add(filepath.Dir(s.file)); err != nil {
		_ = w.Close()
		return err
	}
	s.watcher = w
	s.watchDone = make(chan struct{})
	name := filepath.Base(s.file)
	go func() {
		defer close(s.watchDone)
		for {
			select {
			case ev, ok := <-w.Events:
				if !ok {
					return
				}
				if filepath.Base(ev.Name) == name {
					s.scheduleSyncFromDisk()
				}
			case err, ok := <-w.Errors:
				if !ok {
					return
				}
				s.onError(err)
			}
		}
	}()
	return nil
}

func (s *Session) scheduleSyncFromDisk() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.stopped {
		return
	}
	if s.readTimer != nil {
		s.readTimer.Stop()
	}
	s.readTimer = time.AfterFunc(50*time.Millisecond, func() {
		s.syncing.Lock()
		defer s.syncing.Unlock()
		s.mu.Lock()
		stopped := s.stopped
		s.mu.Unlock()
		if !stopped {
			s.syncFromDisk()
		}
	})
}

// SyncFromDisk merges the file's current content into the doc if it changed
// outside ima, against what we last wrote.
func (s *Session) SyncFromDisk() {
	s.syncing.Lock()
	defer s.syncing.Unlock()
	s.syncFromDisk()
}

// syncFromDisk is SyncFromDisk with s.syncing held.
func (s *Session) syncFromDisk() {
	changed := false
	// Rebase drops any pending write, which predates the merge.
	s.Writer.Rebase(func(lastWritten string) string {
		onDisk, ok := readSettled(s.file)
		if !ok || onDisk == lastWritten {
			return lastWritten
		}
		s.Client.Do(func() {
			merge.ExternalEdit(s.Doc, s.Text, lastWritten, onDisk, fileOrigin)
		})
		changed = true
		return onDisk
	})
	if changed {
		// Remote edits made meanwhile are not on disk yet.
		s.Writer.Schedule(s.Text.ToString())
	}
}

// finalWriteAttempts bounds how often Stop retries when the file keeps changing
// outside ima while it tries to save.
const finalWriteAttempts = 3

// Stop leaves the room and writes the final state to the file. It reports an
// error when the final state could not be saved.
func (s *Session) Stop() error {
	s.stopOnce.Do(func() {
		s.mu.Lock()
		s.stopped = true
		if s.readTimer != nil {
			s.readTimer.Stop()
		}
		s.mu.Unlock()
		if s.watcher != nil {
			_ = s.watcher.Close()
			<-s.watchDone
		}
		// Waits for a sync already started by the timer; none can start after this.
		s.syncing.Lock()
		defer s.syncing.Unlock()

		// Merge a last-second external edit while peers can still get it, and
		// save right away: leaving can take a while, and a second Ctrl+C exits.
		s.syncFromDisk()
		s.Writer.Schedule(s.Text.ToString())
		_ = s.Writer.Flush()

		if s.beforeDestroy != nil {
			s.beforeDestroy()
		}
		s.Client.Destroy()

		// Save again: edits may have arrived while leaving, and none can arrive now.
		for attempt := 1; ; attempt++ {
			if s.beforeFinalWrite != nil {
				s.beforeFinalWrite(attempt)
			}
			s.Writer.Schedule(s.Text.ToString())
			s.stopErr = s.Writer.Flush()
			if !errors.Is(s.stopErr, filewriter.ErrExternalChange) || attempt == finalWriteAttempts {
				break
			}
			// Someone saved the file meanwhile: merge it in and try again.
			s.syncFromDisk()
		}
		s.stopAlive()
		s.awareness.Destroy()
	})
	return s.stopErr
}

// Saving is often truncate-then-write, so a read right after the change event can
// see a half-written file. Read until two consecutive reads agree; report !ok if
// they never do, so a half-written file is not taken for the new content.
func readSettled(path string) (string, bool) {
	return settle(func() (string, bool) { return filewriter.ReadFile(path) }, 30*time.Millisecond, 10)
}

func settle(read func() (string, bool), interval time.Duration, maxReads int) (string, bool) {
	previous, prevOK := read()
	for range maxReads - 1 {
		time.Sleep(interval)
		current, ok := read()
		if current == previous && ok == prevOK {
			return current, ok
		}
		previous, prevOK = current, ok
	}
	return "", false
}
