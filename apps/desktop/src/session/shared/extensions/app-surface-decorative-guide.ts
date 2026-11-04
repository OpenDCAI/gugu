export const APP_SURFACE_DECORATIVE_GUIDE = `# A non-interactive decoration surface (API 30)

Needs \`agents:tools\`
- \`await gugu.surfaces.open({entry,bounds,decorative:true,data?,visible?,relativeTo?})\` creates a decoration.
  decorative defaults to false and is immutable: surface.update does not accept it, a mouse-passthrough switch,
  focus or input-handler options. Close and create a separate surface when different behavior is required.
- Main enables native mouse passthrough without forwarding, disables keyboard/focus and does so before showing
  the document. If that native configuration fails, the surface stays hidden or closes; it never falls back to a
  transparent window that blocks the page below. Display failure cannot block or authorize any tool action.
- A decorative page cannot post input to its program, send projection input, open a modal, request focus or make
  gesture actions such as taskMessage, even if a request falsely claims activation. getContext().surface.decorative
  is a host-held fact. Ordinary DOM listeners do not acquire native input; do not use them to relay a person's actions.
  Use an independent small interactive surface for real buttons. Neither the host nor a decoration forwards input
  by protocol to the page underneath. Actual native click-through must be verified on the target platform.
`;
