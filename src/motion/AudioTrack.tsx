import React, { useEffect, useState } from 'react';
import { Audio, delayRender, continueRender, cancelRender } from 'remotion';
import type { Composition } from '../core/types';
import { audioClipFrames, audioVolumeAtFrame } from './audio';

export function AudioTrack({
  composition,
  src,
  totalFrames,
}: {
  composition: Composition;
  src: string;
  totalFrames: number;
}) {
  const [duration, setDuration] = useState<number>(),
    [handle] = useState(() => delayRender('오디오 길이를 확인하는 중'));
  useEffect(() => {
    // Separate metadata loading from the trimmed Audio sequence: a parallel render tab
    // may start after that sequence ends, where no Remotion audio DOM node is mounted.
    const media = document.createElement('audio');
    media.preload = 'metadata';
    const loaded = () => {
      const seconds = media.duration;
      if (!Number.isFinite(seconds) || seconds <= 0) {
        cancelRender(new Error('오디오 길이를 읽지 못했습니다.'));
        return;
      }
      setDuration(seconds);
      continueRender(handle);
    };
    const failed = () => cancelRender(new Error('오디오 메타데이터를 불러오지 못했습니다.'));
    media.addEventListener('loadedmetadata', loaded);
    media.addEventListener('error', failed);
    media.src = src;
    media.load();
    return () => {
      media.removeEventListener('loadedmetadata', loaded);
      media.removeEventListener('error', failed);
      media.removeAttribute('src');
      media.load();
      continueRender(handle);
    };
  }, [src, handle]);
  if (duration === undefined) return null;
  if ((composition.audioTrimStartFrames ?? 0) >= Math.ceil(duration * composition.fps))
    throw new Error('오디오 시작 구간이 원본 길이 밖에 있습니다.');
  return (
    <Audio
      src={src}
      trimBefore={composition.audioTrimStartFrames ?? 0}
      trimAfter={composition.audioTrimEndFrames}
      volume={(frame) =>
        audioVolumeAtFrame(composition, frame, audioClipFrames(composition, totalFrames, duration))
      }
      onError={(error) => cancelRender(error)}
    />
  );
}
