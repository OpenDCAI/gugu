package projection

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestVideoFrameReceiptsAndSequenceBounds(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	config := testEncoderConfig(t)
	video, err := StartVideoEncoder(ctx, config, ignoreRTP{})
	if err != nil {
		t.Fatal(err)
	}
	defer video.Close()
	pixels := make([]byte, config.Width*config.Height*4)
	first, err := video.WriteFrame(ctx, 41, pixels)
	if err != nil || first.Sequence != 41 || first.Width != config.Width || first.Height != config.Height {
		t.Fatalf("first frame receipt: %+v %v", first, err)
	}
	for _, stale := range []uint64{0, 40, 41, 1 << 53} {
		if _, err = video.WriteFrame(ctx, stale, pixels); err == nil {
			t.Fatalf("invalid sequence %d was encoded", stale)
		}
	}
	if _, err = video.WriteFrame(ctx, 42, []byte{0}); err == nil {
		t.Fatal("partial source frame was admitted")
	}
	second, err := video.WriteFrame(ctx, 42, pixels)
	if err != nil || second.Sequence != 42 || second.Timestamp-first.Timestamp != 90000/uint32(config.FPS) {
		t.Fatalf("same pixels need distinct frame/timestamp receipts: %+v %+v %v", first, second, err)
	}
	cancelled, abort := context.WithCancel(context.Background())
	abort()
	if _, err = video.WriteFrame(cancelled, 43, pixels); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled frame: %v", err)
	}
	if err = video.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err = video.WriteFrame(context.Background(), 43, pixels); !errors.Is(err, ErrClosed) {
		t.Fatalf("closed video encoder admitted a frame: %v", err)
	}
}
