import { app } from 'electron'
import path from 'path'
import { OnlineRecognizer } from 'sherpa-onnx-node'
import { randomUUID } from 'crypto'
import log from 'electron-log/main'

let recognizer: InstanceType<typeof OnlineRecognizer> | null = null
const streams = new Map<string, ReturnType<InstanceType<typeof OnlineRecognizer>['createStream']>>()

function getModelDir(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'models', 'asr')
  }
  return path.join(app.getAppPath(), 'resources', 'models', 'asr')
}

export function initASR(): void {
  const modelDir = getModelDir()
  const modelPrefix = 'sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20'
  const modelPath = path.join(modelDir, modelPrefix)

  try {
    recognizer = new OnlineRecognizer({
      modelConfig: {
        transducer: {
          encoder: path.join(modelPath, 'encoder-epoch-99-avg-1.int8.onnx'),
          decoder: path.join(modelPath, 'decoder-epoch-99-avg-1.int8.onnx'),
          joiner: path.join(modelPath, 'joiner-epoch-99-avg-1.int8.onnx')
        },
        tokens: path.join(modelPath, 'tokens.txt'),
        numThreads: 2,
        provider: 'cpu'
      },
      enableEndpoint: true,
      rule1MinTrailingSilence: 2.4,
      rule2MinTrailingSilence: 1.2,
      rule3MinUtteranceLength: 20,
      decodingMethod: 'greedy_search'
    })
    log.info('[ASR] sherpa-onnx recognizer initialized')
  } catch (err) {
    log.error('[ASR] Failed to initialize recognizer:', err)
    recognizer = null
  }
}

export function createStream(): string {
  if (!recognizer) {
    throw new Error('ASR recognizer not initialized')
  }
  const streamId = randomUUID()
  const stream = recognizer.createStream()
  streams.set(streamId, stream)
  return streamId
}

export function feedAudio(streamId: string, samples: Float32Array): void {
  if (!recognizer) throw new Error('ASR recognizer not initialized')
  const stream = streams.get(streamId)
  if (!stream) throw new Error(`Stream ${streamId} not found`)
  stream.acceptWaveform({ sampleRate: 16000, samples })
  while (recognizer.isReady(stream)) {
    recognizer.decode(stream)
  }
}

export function getResult(streamId: string): string {
  if (!recognizer) return ''
  const stream = streams.get(streamId)
  if (!stream) return ''
  return recognizer.getResult(stream).text
}

export function stopStream(streamId: string): string {
  if (!recognizer) return ''
  const stream = streams.get(streamId)
  if (!stream) return ''

  stream.inputFinished()
  while (recognizer.isReady(stream)) {
    recognizer.decode(stream)
  }
  const finalResult = recognizer.getResult(stream).text
  streams.delete(streamId)
  return finalResult
}
