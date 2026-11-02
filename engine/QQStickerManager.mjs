// Port of QQStickerManager.swift. The whole file is `#if canImport(SwiftUI)` (the macOS sticker window), so the
// Linux build has none of it; only the emotion names are kept, for any panel that lists stickers by mood.
export function stickerEmotionName(emotion) {
  switch (emotion) {
    case 'neutral': return '平静';
    case 'joy': return '开心';
    case 'smug': return '得意';
    case 'annoyed': return '不满';
    case 'sad': return '难过';
    case 'sleepy': return '困倦';
    case 'flustered': return '害羞';
    case 'teasing': return '调侃';
    default: return undefined;
  }
}
