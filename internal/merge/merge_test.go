package merge

import (
	"testing"

	"github.com/reearth/ygo/crdt"
)

func textOf(content string) (*crdt.Doc, *crdt.YText) {
	doc := crdt.New()
	text := doc.GetText("content")
	doc.Transact(func(txn *crdt.Transaction) { text.Insert(txn, 0, content, nil) })
	return doc, text
}

// remote simulates an edit from another peer that is not on disk yet.
func remote(doc *crdt.Doc, text *crdt.YText, index int, s string) {
	doc.Transact(func(txn *crdt.Transaction) { text.Insert(txn, index, s, nil) })
}

func TestExternalEdit(t *testing.T) {
	tests := []struct {
		name   string
		base   string
		remote func(*crdt.Doc, *crdt.YText)
		next   string
		want   string
	}{
		{
			name: "applies the edit when nothing else changed",
			base: "# title\n\nbody\n",
			next: "# Title\n\nbody\nmore\n",
			want: "# Title\n\nbody\nmore\n",
		},
		{
			name:   "keeps remote edits made elsewhere in the document",
			base:   "one\ntwo\nthree\n",
			remote: func(d *crdt.Doc, x *crdt.YText) { remote(d, x, 0, "zero\n") },
			next:   "one\ntwo\nthree\nfour\n",
			want:   "zero\none\ntwo\nthree\nfour\n",
		},
		{
			name:   "keeps both sides when they touch the same line",
			base:   "hello world\n",
			remote: func(d *crdt.Doc, x *crdt.YText) { remote(d, x, 5, ",") },
			next:   "hello world!\n",
			want:   "hello, world!\n",
		},
		{
			name:   "lets an external deletion remove the region it replaced",
			base:   "a\nb\nc\n",
			remote: func(d *crdt.Doc, x *crdt.YText) { remote(d, x, 0, "x") },
			next:   "a\nc\n",
			want:   "xa\nc\n",
		},
		{
			name:   "counts offsets in UTF-16 units around surrogate pairs",
			base:   "🌏 こんにちは\n",
			remote: func(d *crdt.Doc, x *crdt.YText) { remote(d, x, 2, "🐹") },
			next:   "🌏 こんばんは\n😀\n",
			want:   "🌏🐹 こんばんは\n😀\n",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			doc, text := textOf(tt.base)
			if tt.remote != nil {
				tt.remote(doc, text)
			}
			ExternalEdit(doc, text, tt.base, tt.next, "file")
			if got := text.ToString(); got != tt.want {
				t.Fatalf("got %q, want %q", got, tt.want)
			}
		})
	}
}

func TestExternalEditTagsOrigin(t *testing.T) {
	doc, text := textOf("a")
	var origins []any
	doc.OnUpdate(func(_ []byte, origin any) { origins = append(origins, origin) })
	ExternalEdit(doc, text, "a", "ab", "file")
	ExternalEdit(doc, text, "ab", "ab", "file") // no change, no transaction
	if len(origins) != 1 || origins[0] != "file" {
		t.Fatalf("origins = %v", origins)
	}
}
