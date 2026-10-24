import { emitKeypressEvents } from 'node:readline'

export function readHiddenPassword(prompt, input = process.stdin, output = process.stderr) {
  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== 'function') throw new Error('Reset admin memerlukan terminal interaktif; input/output redirect tidak diizinkan.')
  return new Promise((resolve, reject) => {
    const wasRaw = !!input.isRaw
    let value = ''
    function finish(error) {
      input.removeListener('keypress', keypress)
      input.removeListener('end', ended)
      input.removeListener('error', failed)
      input.setRawMode(wasRaw)
      input.pause()
      output.write('\n')
      const secret = value
      value = ''
      if (error) reject(error)
      else resolve(secret)
    }
    function ended() { finish(new Error('Input terminal berakhir. Reset dibatalkan.')) }
    function failed() { finish(new Error('Input terminal gagal. Reset dibatalkan.')) }
    function keypress(text, key = {}) {
      if (key.ctrl && key.name === 'c' || key.name === 'escape') return finish(new Error('Reset dibatalkan.'))
      if (key.name === 'return' || key.name === 'enter') return finish()
      if (key.name === 'backspace') { value = [...value].slice(0, -1).join(''); return }
      if (!key.ctrl && !key.meta && text && !/[\x00-\x1f\x7f]/.test(text)) {
        value += text
        if (value.length > 1024) finish(new Error('Input password terlalu panjang. Reset dibatalkan.'))
      }
    }
    output.write(prompt)
    emitKeypressEvents(input)
    input.on('keypress', keypress)
    input.once('end', ended)
    input.once('error', failed)
    input.setRawMode(true)
    input.resume()
  })
}
