// ffprobe-static ships JS only; this tiny ambient declaration tells
// TS what the `path` property looks like so the composer module
// can `import ffprobeStatic from "ffprobe-static"` without TS7016.
declare module "ffprobe-static" {
  const ffprobeStatic: { path: string };
  export default ffprobeStatic;
}
