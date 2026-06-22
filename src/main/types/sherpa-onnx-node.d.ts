declare module 'sherpa-onnx-node' {
  interface TransducerConfig {
    encoder: string
    decoder: string
    joiner: string
  }

  interface ModelConfig {
    transducer: TransducerConfig
    tokens: string
    numThreads: number
    provider: string
  }

  interface OnlineRecognizerConfig {
    modelConfig: ModelConfig
    enableEndpoint: boolean
    rule1MinTrailingSilence: number
    rule2MinTrailingSilence: number
    rule3MinUtteranceLength: number
    decodingMethod: string
  }

  interface WaveformInput {
    sampleRate: number
    samples: Float32Array
  }

  interface RecognitionResult {
    text: string
  }

  interface OnlineStream {
    acceptWaveform(input: WaveformInput): void
    inputFinished(): void
  }

  class OnlineRecognizer {
    constructor(config: OnlineRecognizerConfig)
    createStream(): OnlineStream
    isReady(stream: OnlineStream): boolean
    decode(stream: OnlineStream): void
    getResult(stream: OnlineStream): RecognitionResult
    isEndpoint(stream: OnlineStream): boolean
    reset(stream: OnlineStream): void
  }
}
