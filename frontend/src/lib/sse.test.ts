/**
 * CodeConClave — SSE frame parser unit tests (pure, node env).
 * Phase 16: frames carry optional id: lines for missed-event replay.
 */
import { describe, it, expect } from 'vitest';
import { parseSseFrames } from './sse';

describe('parseSseFrames', () => {
  it('parses a single event frame', () => {
    const frames = parseSseFrames('event: thinking_start\ndata: {}\n\n');
    expect(frames).toEqual([{ name: 'thinking_start', data: '{}', id: null }]);
  });

  it('parses multiple frames including multi-line data', () => {
    const stream = [
      'event: delta\ndata: {"delta":"Hel',
      'lo"}\n\n',
      'event: done\ndata: {"conversationId":"c_1"}\n\n',
    ].join('');
    const frames = parseSseFrames(stream);
    expect(frames).toHaveLength(2);
    expect(frames[0]).toEqual({ name: 'delta', data: '{"delta":"Hello"}', id: null });
    expect(frames[1]).toEqual({ name: 'done', data: '{"conversationId":"c_1"}', id: null });
  });

  it('parses id: lines and keeps an empty id as null', () => {
    const frames = parseSseFrames('id: evt_42\nevent: delta\ndata: {"delta":"x"}\n\n');
    expect(frames[0]).toEqual({ name: 'delta', data: '{"delta":"x"}', id: 'evt_42' });
    const noId = parseSseFrames('id: \nevent: done\ndata: {}\n\n');
    expect(noId[0]!.id).toBeNull();
  });

  it('ignores frames without an event name', () => {
    const frames = parseSseFrames('data: {"x":1}\n\n');
    expect(frames).toEqual([]);
  });

  it('leaves partial trailing frames for the next chunk', () => {
    const frames = parseSseFrames('event: delta\ndata: {"d');
    expect(frames).toEqual([]);
  });
});