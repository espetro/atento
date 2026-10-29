/**
 * The ASR port: one function that turns a 16 kHz mono wav file into text.
 *
 * The port lives in core so the media stage (which does the downloading and
 * the ffmpeg conversion) and the enrich package (which owns the model call)
 * agree on one shape without depending on each other. No provider or model
 * is named here: the implementation decides that from the environment.
 */

/** One transcription request: a local wav file on disk. */
export interface AsrRequest {
  /** Absolute path to a 16 kHz mono wav file. */
  audioPath: string
  /** Optional language hint, e.g. "en". */
  language?: string
}

/** One transcription result. */
export interface AsrResponse {
  /** The transcript text. Empty when nothing was recognised. */
  text: string
  /** Duration of the audio in seconds, when the provider reports it. */
  audioDurationSeconds?: number
  /** Provider metrics, e.g. wall time and real-time factor. */
  metrics?: Record<string, number>
}

/** The transcription function the media stage depends on. */
export type AsrFn = (request: AsrRequest) => Promise<AsrResponse>
