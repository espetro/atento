import { describe, expect, it } from 'vitest'
import { captionTier, extractHashtags, parseCount, parseMetaBlock } from '../src/caption.js'

describe('caption tier', () => {
  it('reports empty when the content carries nothing', () => {
    const result = captionTier({ content: '' }, 0)
    expect(result.status).toBe('empty')
  })

  it('reads the caption, hashtags and counts from the extracted content', () => {
    const result = captionTier(
      {
        content: [
          'A clip about #ferns and #spring.',
          '',
          'Likes: 1,234',
          'Comments: 12',
        ].join('\n'),
      },
      0,
    )
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    expect(result.caption).toBe('A clip about #ferns and #spring.')
    expect(result.hashtags).toEqual(['ferns', 'spring'])
    expect(result.likeCount).toBe(1234)
    expect(result.commentCount).toBe(12)
  })

  it('reads the metadata block the extractor left behind', () => {
    const content = [
      '<!--media-meta',
      '{"author":"someone","audioTrack":"Original audio","likeCount":7,"caption":"Hi there"}',
      '-->',
      '',
      'Hi there',
    ].join('\n')
    const result = captionTier({ content }, 0)
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    expect(result.author).toBe('someone')
    expect(result.audioTrack).toBe('Original audio')
    expect(result.likeCount).toBe(7)
    expect(result.caption).toBe('Hi there')
  })

  it('prefers the metadata over the text', () => {
    const result = captionTier(
      { content: '<!--media-meta\n{"author":"meta-author"}\n-->\n\nBody text' },
      0,
    )
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    expect(result.author).toBe('meta-author')
  })

  it('survives a malformed metadata block', () => {
    const result = captionTier({ content: '<!--media-meta\n{not json}\n-->\n\nBody' }, 0)
    expect(result.status).toBe('ok')
  })
})

describe('helpers', () => {
  it('parses counts with separators and suffixes', () => {
    expect(parseCount('1,234')).toBe(1234)
    expect(parseCount('1.2k')).toBe(1200)
    expect(parseCount('3M')).toBe(3000000)
    expect(parseCount('none')).toBeUndefined()
  })

  it('extracts unique hashtags', () => {
    expect(extractHashtags('#a #B #a')).toEqual(['a', 'b'])
  })

  it('returns an empty metadata map for a missing block', () => {
    expect(parseMetaBlock('no block here')).toEqual({})
  })
})
