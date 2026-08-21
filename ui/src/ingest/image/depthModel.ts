/**
 * Where the depth model comes from, and how big it is.
 *
 * Kept in one place because both numbers are shown to the user before anything is downloaded.
 * A prompt that says "this will take a moment" and then spends fifty megabytes of somebody's
 * data allowance has not asked them anything.
 *
 * The URL is the official Depth Anything V2 ONNX export on Hugging Face. It is Apache-2.0, and it
 * is somebody else's server: nothing fetches it until a user asks for it, and the browser caches
 * it afterwards so the cost is paid once.
 */
export const DEPTH_MODEL = {
  label: 'Depth Anything V2 (small)',
  url: 'https://huggingface.co/onnx-community/depth-anything-v2-small/resolve/main/onnx/model.onnx',
  /** Roughly, for telling the user before they commit to it. */
  megabytes: 50,
  licence: 'Apache-2.0',
} as const;
