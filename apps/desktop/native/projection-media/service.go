package projection

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"sync"
	"sync/atomic"
	"time"
)

// ServeMedia runs one already-authorized host media connection. Neither this
// pipe nor SDP creates an App/task grant. The parent must own the resource,
// validate every input and release its injected controls before stopping it.
// Config and encoder paths come from the trusted parent, never the remote peer.
// input.Close must interrupt its active Read; wrap non-pollable inherited stdin
// in the cancellable pipe used by cmd/projection-media rather than passing it directly.
func ServeMedia(parent context.Context, config Config, encoding EncoderConfig, input io.ReadCloser, output io.WriteCloser) error {
	defer input.Close()
	defer output.Close()
	if !validEncoderConfig(encoding) {
		return errors.New("invalid projection encoder configuration")
	}
	if err := parent.Err(); err != nil {
		return err
	}
	ctx, cancel := context.WithCancel(parent)
	defer cancel()
	stopIO := context.AfterFunc(ctx, func() { _ = input.Close(); _ = output.Close() })
	defer stopIO()
	peer, err := New(config)
	if err != nil {
		return err
	}
	defer peer.Close()
	var writing sync.Mutex
	emit := func(message MediaMessage) error {
		writing.Lock()
		defer writing.Unlock()
		return writeMessage(output, message)
	}
	startup, finishStartup := context.WithTimeout(ctx, 10*time.Second)
	offer, err := peer.Offer(startup)
	finishStartup()
	if err != nil {
		return err
	}
	if err = emit(MediaMessage{Type: "offer", SDP: &offer}); err != nil {
		return err
	}
	received := make(chan struct{})
	var closing atomic.Bool
	var workers sync.WaitGroup
	workers.Add(1)
	go func() {
		defer workers.Done()
		defer close(received)
		for {
			data, receiveErr := peer.Receive(ctx)
			if receiveErr != nil {
				if !closing.Load() && ctx.Err() == nil {
					_ = emit(MediaMessage{Type: "error", Error: receiveErr.Error()})
					cancel()
				}
				return
			}
			if emit(MediaMessage{Type: "control", Data: string(data)}) != nil {
				cancel()
				return
			}
		}
	}()
	var video *VideoEncoder
	defer func() {
		closing.Store(true)
		if video != nil {
			_ = video.Close()
		}
		cancel()
		_ = peer.Close()
		workers.Wait()
	}()
	wires := make(chan incomingWire)
	readDone := make(chan struct{})
	go func() { defer close(readDone); readMediaWires(ctx, input, encoding.Width*encoding.Height*4, wires) }()
	var borrowed chan struct{}
	defer func() {
		if borrowed != nil {
			close(borrowed)
		}
		cancel()
		_ = input.Close()
		<-readDone
	}()
	// Recovery sends the same source picture, with a fresh IDR/RTP timestamp,
	// without waiting for a source ACK that cannot arrive after picture loss.
	var recoverAt <-chan time.Time
	timer := time.NewTimer(time.Hour)
	if !timer.Stop() {
		<-timer.C
	}
	defer timer.Stop()
	var lastRecovery time.Time
	emitFrame := func(receipt EncodedFrame) error {
		metadata, err := json.Marshal(MediaMessage{Type: "frame", Frame: &receipt})
		if err != nil {
			return err
		}
		return peer.Send(ctx, metadata)
	}
	for {
		if borrowed != nil {
			close(borrowed)
			borrowed = nil
		}
		var incoming incomingWire
		var encoderDone <-chan struct{}
		if video != nil {
			encoderDone = video.encoder.done
		}
		select {
		case <-encoderDone:
			failure := video.encoder.closedError()
			_ = emit(MediaMessage{Type: "error", Error: failure.Error()})
			return failure
		case <-peer.keyframes:
			if recoverAt == nil && video != nil && video.completed != 0 {
				delay := time.Until(lastRecovery.Add(time.Second))
				if delay < 0 {
					delay = 0
				}
				timer.Reset(delay)
				recoverAt = timer.C
			}
			continue
		case <-recoverAt:
			recoverAt = nil
			receipt, err := video.RefreshFrame(ctx)
			if err != nil {
				return err
			}
			lastRecovery = time.Now()
			if err = emitFrame(receipt); err != nil {
				return err
			}
			continue
		case <-ctx.Done():
			return ctx.Err()
		case incoming = <-wires:
		}
		borrowed = incoming.release
		kind, data, readErr := incoming.kind, incoming.data, incoming.err
		if readErr != nil {
			if parent.Err() != nil {
				return parent.Err()
			}
			if errors.Is(readErr, io.EOF) {
				return nil
			}
			return readErr
		}
		if kind == wireFrame {
			if video == nil {
				return errors.New("video is not connected")
			}
			sequence := binary.BigEndian.Uint64(data[:8])
			receipt, frameErr := video.WriteFrame(ctx, sequence, data[8:])
			if frameErr != nil {
				return frameErr
			}
			if err = emitFrame(receipt); err != nil {
				return err
			}
			if err = emit(MediaMessage{Type: "encoded", Frame: &receipt}); err != nil {
				return err
			}
			continue
		}
		var command MediaMessage
		if err = json.Unmarshal(data, &command); err != nil {
			return err
		}
		switch command.Type {
		case "answer":
			if video != nil || command.SDP == nil {
				return errors.New("invalid native media answer")
			}
			if err = peer.Remote(*command.SDP); err != nil {
				return err
			}
			connecting, finish := context.WithTimeout(ctx, 15*time.Second)
			err = peer.Ready(connecting)
			finish()
			if err != nil {
				return err
			}
			video, err = StartVideoEncoder(ctx, encoding, peer)
			if err != nil {
				return err
			}
			if err = emit(MediaMessage{Type: "ready", ID: command.ID}); err != nil {
				return err
			}
		case "send":
			if video == nil {
				return errors.New("control is not connected")
			}
			if err = peer.Send(ctx, []byte(command.Data)); err != nil {
				return err
			}
			// "sent" only acknowledges SCTP admission. Native execution results
			// must come from the host input driver and retain their operation id.
			if err = emit(MediaMessage{Type: "sent", ID: command.ID}); err != nil {
				return err
			}
		case "close":
			closing.Store(true)
			if video != nil {
				if err = video.Close(); err != nil {
					return err
				}
			}
			if err = peer.Close(); err != nil {
				return err
			}
			<-received
			return emit(MediaMessage{Type: "closed", ID: command.ID})
		default:
			return fmt.Errorf("unknown native media command: %q", command.Type)
		}
	}
}
