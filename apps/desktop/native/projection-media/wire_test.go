package projection

import (
	"bytes"
	"context"
	"io"
	"testing"
	"time"
)

func TestWireSlabWaitsForReturnAndIsReused(t *testing.T) {
	const size = 1280 * 720 * 4
	var stream bytes.Buffer
	first, second := bytes.Repeat([]byte{17}, size+8), bytes.Repeat([]byte{99}, size+8)
	if err := writeWire(&stream, wireFrame, first); err != nil {
		t.Fatal(err)
	}
	if err := writeWire(&stream, wireFrame, second); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	wires := make(chan incomingWire)
	done := make(chan struct{})
	go func() { defer close(done); readMediaWires(ctx, &stream, size, wires) }()
	defer func() { cancel(); <-done }()
	next := func() incomingWire {
		t.Helper()
		select {
		case item := <-wires:
			return item
		case <-time.After(time.Second):
			t.Fatal("reader blocked")
			return incomingWire{}
		}
	}
	one := next()
	if one.err != nil || !bytes.Equal(one.data, first) {
		t.Fatal("first frame differs")
	}
	// The reader must neither read nor overwrite a borrowed slab while encoding.
	time.Sleep(20 * time.Millisecond)
	if !bytes.Equal(one.data, first) {
		t.Fatal("reader overwrote an in-flight picture")
	}
	address := &one.data[0]
	close(one.release)
	two := next()
	if two.err != nil || !bytes.Equal(two.data, second) {
		t.Fatal("second frame differs")
	}
	if address != &two.data[0] {
		t.Fatal("full raw-frame slab was allocated again")
	}
	close(two.release)
	end := next()
	if end.err != io.EOF {
		t.Fatalf("missing EOF: %v", end.err)
	}
	close(end.release)
}

func TestWireReaderCancellationWhileSlabIsBorrowed(t *testing.T) {
	var stream bytes.Buffer
	_ = writeWire(&stream, wireFrame, make([]byte, 24))
	ctx, cancel := context.WithCancel(context.Background())
	wires := make(chan incomingWire)
	done := make(chan struct{})
	go func() { defer close(done); readMediaWires(ctx, &stream, 16, wires) }()
	select {
	case <-wires:
	case <-time.After(time.Second):
		cancel()
		t.Fatal("missing frame")
	}
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("borrowed slab retained cancelled reader")
	}
}
