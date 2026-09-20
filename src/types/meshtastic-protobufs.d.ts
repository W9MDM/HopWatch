// The @meshtastic/protobufs package ships generated JS without bundled .d.ts that
// TypeScript can resolve here. We treat it as an untyped module and confine all
// access to src/meshtastic/decode.ts, which normalizes into typed shapes.
declare module "@meshtastic/protobufs";
