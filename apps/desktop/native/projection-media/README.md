# Shared projection media transport (work in progress)

This dependency branch follows #987. It starts the host media backend shared by desktop and the headless server; it is not yet wired into App resources or device signaling.

The backend pins [Pion WebRTC v4.2.26](https://github.com/pion/webrtc/releases/tag/v4.2.26), uses an H.264 RTP video track and a reliable ordered input DataChannel, and accepts only STUN discovery configuration. Relay candidates are rejected in remote descriptions and the selected pair is checked before application traffic. The host must still bind App/task/target/epoch authorization and interpret execution acknowledgements. Sending bytes does not mean native input was applied.

`go test -race ./...` checks an actual local ICE/DTLS/SRTP/SCTP connection, ordered bidirectional control, RTP payload delivery, close, relay refusal and control size bounds. The RTP payload in this test is synthetic: encoder output, browser video decoding, cross-device connectivity and production signaling remain unverified. FFmpeg integration and packaging are subsequent work.

Pion is BSD-3-Clause licensed; its modules and checksums are pinned in `go.mod`/`go.sum`. The upstream [RTP-to-WebRTC example](https://github.com/pion/webrtc/tree/main/examples/rtp-to-webrtc) documents the encoder/transport boundary.
