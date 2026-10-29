# Shared projection media transport (work in progress)

This dependency branch follows #987. It starts the host media backend shared by desktop and the headless server; it is not yet wired into App resources or device signaling.

The backend pins [Pion WebRTC v4.2.26](https://github.com/pion/webrtc/releases/tag/v4.2.26), uses an H.264 RTP video track and a reliable ordered input DataChannel, and accepts only STUN discovery configuration. Relay candidates are rejected in remote descriptions and the selected pair is checked before application traffic. The host must still bind App/task/target/epoch authorization and interpret execution acknowledgements. Sending bytes does not mean native input was applied.

`go test -race ./...` checks an actual local ICE/DTLS/SRTP/SCTP connection, ordered bidirectional control, RTP payload delivery, close, relay refusal and control size bounds. The encoder tests feed three raw BGRA frames into FFmpeg, send its H.264 RTP across the encrypted connection, decode the received stream with FFmpeg, and verify pixel colors and order. Cancellation waits for the encoder process and UDP reader to exit.

`GUGU_TEST_CHROMIUM=/absolute/path/to/chromium go test -race -tags browser ./...` additionally starts an isolated headless browser and verifies that its video track decodes the same three colors onto a canvas. Browser and encoder failures include their bounded diagnostics, and both child processes are awaited during cleanup. This test does not operate an installed Gugu instance or a user's browser.

The host supplies an absolute trusted FFmpeg executable with libx264. The encoder currently uses `-fps_mode passthrough` (FFmpeg 5.1 or later); FFmpeg 9 removed the older `-vsync` option. Test binaries can be selected with `GUGU_PROJECTION_FFMPEG` and `GUGU_TEST_CHROMIUM`. Production binary packaging, codec-level and geometry negotiation, frame-to-input association, large-text transfer, cross-device connectivity, authenticated device signaling and App integration remain unfinished. No encoded bytes or inputs use the signaling channel, and there is no relay or image-stream fallback.

Pion WebRTC v4.2.26 is [MIT licensed](https://github.com/pion/webrtc/blob/v4.2.26/LICENSE); its modules and checksums are pinned in `go.mod`/`go.sum`. Dependencies retain their own licenses. The upstream [RTP-to-WebRTC example](https://github.com/pion/webrtc/tree/v4.2.26/examples/rtp-to-webrtc) documents the encoder/transport boundary.
