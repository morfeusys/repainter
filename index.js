const TelegramBot = require('node-telegram-bot-api')
const axios = require('axios')
const concat = require('concat-stream')
const { Base64Encode } = require('base64-stream')

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true, onlyFirstMatch: true })

const models = {
    mlsd: 'control_sd15_mlsd [fef5e48e]',
    hed: 'control_sd15_hed [fef5e48e]',
    scribble: 'control_sd15_scribble [fef5e48e]',
    none: 'control_sd15_scribble [fef5e48e]'
}
const photos = {}
const metas = {}
const prompts = {}
const styles = ['Abstract', 'Documentary', 'Still-life', 'Conceptual', 'Fashion', 'Black-and-white']
const awaitingMessages = ['Repainting your image...', 'Processing your image...', 'Creating a new masterpiece...']

bot.on('photo', msg => {
    const chatId = msg.chat.id
    photos[chatId] = msg
    bot.sendMessage(chatId, 'How do you want to repaint this image?\n\n_Note that you can type or send a voice on any language._', {
        parse_mode: 'Markdown',
        reply_to_message_id: msg.message_id,
        reply_markup: {
            inline_keyboard: [
                [{ text: 'Randomly', callback_data: 'random' }]
            ]
        }
    })
})

bot.on('callback_query', query => {
    if (query.data === 'random') {
        const style = styles[Math.floor(Math.random() * styles.length)]
        repaint(query.message, style)
    }
    if (query.data === 'repaint') {
        const style = query.message.caption
        repaint(query.message, style)
    }
})

bot.on('voice', async (msg) => {
    const text = await transcribe(await bot.getFileStream(msg.voice.file_id))
    bot.sendMessage(msg.chat.id, text, {
        reply_to_message_id: msg.message_id,
    })
    repaint(msg, text)
})

bot.on('text', msg => {
    repaint(msg, msg.text)
})

async function repaint(msg, style) {
    const chatId = msg.chat.id
    const photoMessage = msg.reply_to_message && msg.reply_to_message.photo ? msg.reply_to_message : photos[chatId]
    if (!photoMessage) {
        bot.sendMessage(msg.chat.id, 'Send me an image and I will repaint it! 🎨')
        return
    }
    photos[chatId] = photoMessage
    const awaitMessage = await bot.sendMessage(chatId, awaitingMessages[Math.floor(Math.random() * awaitingMessages.length)])
    const photo = photoMessage.photo.sort((a,b) => b.width*b.height - a.width*a.height)[0]
    try {
        const prompt = prompts[photoMessage.message_id] || await interrogate(await bot.getFileStream(photo.file_id))
        prompts[photoMessage.message_id] = prompt
        const meta = metas[photoMessage.message_id] || await getMeta(prompt)
        metas[photoMessage.message_id] = meta
        console.log(`Meta for [${prompt}]\n${JSON.stringify(meta, null, 2)}`)
        const final = await modifyMeta(meta, style)
        console.log(`Modified meta for [${prompt}]\n${JSON.stringify(final, null, 2)}`)
        bot.editMessageText('Repainting... Please wait a bit...', {chat_id: chatId, message_id: awaitMessage.message_id})
        const result = await txt2img(await bot.getFileStream(photo.file_id), final, photo.width, photo.height)
        bot.sendPhoto(chatId, result, {
            caption: style,
            reply_to_message_id: photoMessage.message_id,
            reply_markup: {
                inline_keyboard: [
                    [{ text: 'Try again', callback_data: 'repaint' }]
                ]
            }
        })
    } catch (e) {
        console.error(e)
        bot.sendMessage(chatId, 'Sorry, I cannot repaint this photo.\n'+e.message)
    } finally {
        bot.deleteMessage(chatId, awaitMessage.message_id)
    }
}

async function txt2img(stream, meta, width, height) {
    const base64 = await toBase64(stream)
    const module = meta['sketch'] ? 'none' : (meta['interior'] && !meta['humans'] && !meta['face'] ? 'mlsd' : 'hed')
    const model = models[module]
    console.log(`Rendering [${meta['prompt']}] with [${module}] and [${model}]`)
    const data = {
        "prompt": meta['prompt'],
        "negative_prompt": "blurry, deformed face, part of face, extra faces, deformed hands, deformed fingers, ugly, bad anatomy, extra fingers, bad anatomy, extra legs",
        "sampler_name": "DPM++ 2S a Karras",
        "batch_size": 1,
        "n_iter": 1,
        "steps": 50,
        "cfg_scale": 8,
        "width": width,
        "height": height,
        "restore_faces": !!meta['face'] || !!meta['humans'],
        "tiling": false,
        "sampler_index": "DPM++ 2S a Karras",
        "controlnet_units": [
            {
                "input_image": base64,
                "mask": "",
                "module": module,
                "model": model,
                "weight": 1,
                "resize_mode": "Just Resize",
                "lowvram": false,
                "processor_res": 64,
                "threshold_a": 64,
                "threshold_b": 64,
                "guidance": 1,
                "guidance_start": 0,
                "guidance_end": 1,
                "guessmode": false
            }
        ]
    }

    const resp = await axios.post(`${process.env.API_URL}/sd/controlnet/txt2img`, data, {
        responseType: 'stream'
    })
    return resp.data
}

async function getMeta(prompt) {
    return await getChatJson('Extract features of image from description. Write a json with fields:\n' +
        'object - main objects of image (string)\n' +
        'env - image environment description (string)\n' +
        'type - a type of image (string "photo", "painting", "art", etc)\n' +
        'style - a style of image\n' +
        'interior - true if the main object is an interior without people (boolean)\n' +
        'humans - true if image contains humans (boolean)\n' +
        'face - true if the main object is a human and face is in focus (boolean)\n' +
        'photo - true if the image is a photo (boolean)\n' +
        'sketch - true if the image is a scribble, sketch or ink painting (boolean)\n\n' +
        'Return only a  JSON without any explanations.\n\n' +
        `Description: ${prompt}`)
}

async function modifyMeta(meta, style) {
    const result = await getChatJson(`change image JSON meta to remake it to "${style}". Change type of image accordingly to new meta if needed. Add additional string fields to JSON if needed. Return only a  JSON without any explanations.\n${JSON.stringify(meta, null, 2)}`)
    result['type'] = result['photo'] ? 'photography' : result['type']
    result['sketch'] = meta['sketch']
    result['interior'] = meta['interior']
    result['face'] = meta['face']
    result['prompt'] = Object.values(result).filter(v => typeof v === 'string').join(', ') + `, (${style}):1.2`
    return result
}

async function getChatJson(message) {
    const resp = await axios.post(`${process.env.API_URL}/chatgpt/chat`, {
        prompt: message,
        options: {
            max_tokens: 150
        }
    })
    if (!resp.data['text'] || !resp.data['text'].length) {
        throw new Error('cannot receive response from chatGPT')
    }
    const res = resp.data['text']
    const json = res.substring(res.indexOf('{'), res.lastIndexOf('}') + 1)
    try {
        return JSON.parse(json)
    } catch (e) {
        console.error('Cannot parse JSON\n' + res)
        throw new Error('try a bit later')
    }
}

async function interrogate(stream) {
    const resp = await axios.post(`${process.env.API_URL}/sd/interrogate`, stream, {
        headers: {
            "Content-Type": "binary/octet-stream"
        }
    })
    let caption = resp.data
    if (!caption) {
        throw new Error('cannot generate prompt')
    }
    return caption.replace('<error>', '')
}

async function transcribe(stream) {
    const resp = await axios.post(`${process.env.API_URL}/whisper/transcribe?language=en`, stream, {
        headers: {
            "Content-Type": "binary/octet-stream"
        }
    })
    return resp.data
}

function toBase64(stream) {
    return new Promise((resolve, reject) => {
        const base64 = new Base64Encode()

        const cbConcat = (base64) => {
            resolve(base64)
        }

        stream
            .pipe(base64)
            .pipe(concat(cbConcat))
            .on('error', (error) => {
                reject(error)
            })
    })
}