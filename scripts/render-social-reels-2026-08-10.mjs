import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const batchDir = path.join(repoRoot, 'marketing/social-posts/publer-batches/2026-08-10-to-16');
const source = JSON.parse(fs.readFileSync(path.join(batchDir, 'reel-storyboards.json'), 'utf8'));
const renderDir = path.join(repoRoot, 'marketing/social-posts/reel-renders/2026-08-10-to-16');
const outputDir = path.join(repoRoot, 'marketing/social-posts/reels/2026-08-10-to-16');
fs.mkdirSync(renderDir, { recursive: true });
fs.mkdirSync(outputDir, { recursive: true });

const colors = ['#146A4A', '#0E1512', '#225C4B', '#163E32'];

function xml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function illustration(index, color) {
  const mint = '#B7E9CF';
  const bright = '#4FCC8E';
  const x = 72;
  const y = 1230;
  if (index % 5 === 0) {
    return `<path d="M${x} ${y + 170}h132l48-82 86 188 85-270 67 164h220" fill="none" stroke="${mint}" stroke-width="18" stroke-linecap="round" stroke-linejoin="round"/>`;
  }
  if (index % 5 === 1) {
    return `<rect x="${x}" y="${y}" width="455" height="240" rx="32" fill="none" stroke="${mint}" stroke-width="14"/><path d="M${x + 42} ${y + 174}h76l34-72 58 132 52-180 47 120h120" fill="none" stroke="${bright}" stroke-width="14" stroke-linecap="round" stroke-linejoin="round"/>`;
  }
  if (index % 5 === 2) {
    return `<circle cx="250" cy="${y + 126}" r="112" fill="none" stroke="${mint}" stroke-width="16"/><path d="M250 ${y + 46}v160M170 ${y + 126}h160" stroke="${bright}" stroke-width="16" stroke-linecap="round"/><circle cx="550" cy="${y + 86}" r="20" fill="${mint}"/><circle cx="630" cy="${y + 150}" r="20" fill="${mint}"/><circle cx="710" cy="${y + 86}" r="20" fill="${mint}"/>`;
  }
  if (index % 5 === 3) {
    return `<path d="M${x + 6} ${y + 222}V${y + 54}h136v168zm176 0V${y + 110}h136v112zm176 0V${y}h136v222z" fill="${mint}" opacity="0.92"/><path d="M${x} ${y + 250}h560" stroke="${bright}" stroke-width="14" stroke-linecap="round"/>`;
  }
  return `<path d="M${x + 30} ${y + 220}c0-118 96-214 214-214s214 96 214 214" fill="none" stroke="${mint}" stroke-width="17"/><path d="M${x + 30} ${y + 220}h428" stroke="${mint}" stroke-width="17" stroke-linecap="round"/><path d="M${x + 128} ${y + 138}l82 72 138-162" fill="none" stroke="${bright}" stroke-width="23" stroke-linecap="round" stroke-linejoin="round"/>`;
}

function makeSvg(post, slide, slideIndex, postIndex) {
  const color = colors[(postIndex + slideIndex) % colors.length];
  const accent = '#B7E9CF';
  const [eyebrow, headline, support] = slide;
  const shortHead = headline.length > 24 ? 67 : 78;
  const supportSize = support.length > 29 ? 40 : 46;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1920" viewBox="0 0 1080 1920">
  <rect width="1080" height="1920" fill="${color}"/>
  <rect x="54" y="54" width="972" height="1812" rx="34" fill="none" stroke="#ffffff" stroke-opacity="0.14" stroke-width="3"/>
  <text x="72" y="178" font-family="Arial" font-size="30" font-weight="700" letter-spacing="2" fill="${accent}">${xml(eyebrow.toUpperCase())}</text>
  <text x="72" y="440" font-family="Arial" font-size="${shortHead}" font-weight="700" fill="#FFFFFF">${xml(headline)}</text>
  <text x="72" y="550" font-family="Arial" font-size="${supportSize}" fill="#E4F4EA">${xml(support)}</text>
  ${illustration(slideIndex + postIndex, color)}
  <text x="72" y="1740" font-family="Arial" font-size="28" font-weight="700" letter-spacing="1" fill="${accent}">KEEP GOING · ${slideIndex + 1} OF 8</text>
  <rect x="72" y="1778" width="${Math.round((slideIndex + 1) * 114)}" height="10" rx="5" fill="${accent}"/>
  <rect x="72" y="1778" width="912" height="10" rx="5" fill="#FFFFFF" fill-opacity="0.16"/>
  <rect x="72" y="1778" width="${Math.round((slideIndex + 1) * 114)}" height="10" rx="5" fill="${accent}"/>
  </svg>`;
}

const renderEntries = [];
for (const [postIndex, post] of source.entries()) {
  const slidePaths = [];
  for (const [slideIndex, slide] of post.slides.entries()) {
    const base = `${post.id}-${String(slideIndex + 1).padStart(2, '0')}`;
    const svgPath = path.join(renderDir, `${base}.svg`);
    const pngPath = path.join(renderDir, `${base}.png`);
    fs.writeFileSync(svgPath, makeSvg(post, slide, slideIndex, postIndex));
    execFileSync('rsvg-convert', ['-w', '1080', '-h', '1920', svgPath, '-o', pngPath]);
    slidePaths.push(pngPath);
  }
  const day = post.date.slice(0, 10).replaceAll('/', '-');
  const slot = post.date.slice(11, 13) === '08' ? 'am' : 'pm';
  renderEntries.push({ output: path.join(outputDir, `reel-${day}-${slot}.mp4`), slidePaths });
}

function swiftString(value) {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

const swiftEntries = renderEntries.map(entry => `(${swiftString(entry.output)}, [${entry.slidePaths.map(swiftString).join(', ')}])`).join(',\n');
const swiftSource = `import AppKit
import AVFoundation
import CoreMedia
import CoreVideo

let entries: [(String, [String])] = [
${swiftEntries}
]
let width = 1080
let height = 1920
let frameDuration = CMTime(seconds: 7.5, preferredTimescale: 600)

func makePixelBuffer(from image: NSImage, adaptor: AVAssetWriterInputPixelBufferAdaptor) -> CVPixelBuffer? {
    var pixelBuffer: CVPixelBuffer?
    let status = CVPixelBufferPoolCreatePixelBuffer(nil, adaptor.pixelBufferPool!, &pixelBuffer)
    guard status == kCVReturnSuccess, let buffer = pixelBuffer else { return nil }
    CVPixelBufferLockBaseAddress(buffer, [])
    defer { CVPixelBufferUnlockBaseAddress(buffer, []) }
    guard let context = CGContext(
        data: CVPixelBufferGetBaseAddress(buffer), width: width, height: height,
        bitsPerComponent: 8, bytesPerRow: CVPixelBufferGetBytesPerRow(buffer),
        space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipFirst.rawValue
    ) else { return nil }
    context.setFillColor(NSColor.black.cgColor)
    context.fill(CGRect(x: 0, y: 0, width: width, height: height))
    guard let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else { return nil }
    context.draw(cgImage, in: CGRect(x: 0, y: 0, width: width, height: height))
    return buffer
}

for (outputPath, slidePaths) in entries {
    let outputURL = URL(fileURLWithPath: outputPath)
    try? FileManager.default.removeItem(at: outputURL)
    let writer = try AVAssetWriter(outputURL: outputURL, fileType: .mp4)
    let input = AVAssetWriterInput(mediaType: .video, outputSettings: [
        AVVideoCodecKey: AVVideoCodecType.h264,
        AVVideoWidthKey: width,
        AVVideoHeightKey: height,
        AVVideoCompressionPropertiesKey: [AVVideoAverageBitRateKey: 6_000_000]
    ])
    input.expectsMediaDataInRealTime = false
    let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: [
        kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32ARGB,
        kCVPixelBufferWidthKey as String: width,
        kCVPixelBufferHeightKey as String: height,
        kCVPixelBufferCGImageCompatibilityKey as String: true,
        kCVPixelBufferCGBitmapContextCompatibilityKey as String: true
    ])
    guard writer.canAdd(input) else { fatalError("Cannot add input for \\(outputPath)") }
    writer.add(input)
    guard writer.startWriting() else { fatalError("Cannot start writer for \\(outputPath)") }
    writer.startSession(atSourceTime: .zero)
    for (index, slidePath) in slidePaths.enumerated() {
        guard let image = NSImage(contentsOfFile: slidePath), let buffer = makePixelBuffer(from: image, adaptor: adaptor) else {
            fatalError("Cannot read \\(slidePath)")
        }
        while !input.isReadyForMoreMediaData { Thread.sleep(forTimeInterval: 0.03) }
        guard adaptor.append(buffer, withPresentationTime: CMTimeMultiply(frameDuration, multiplier: Int32(index))) else {
            fatalError("Cannot append \\(slidePath)")
        }
    }
    input.markAsFinished()
    let done = DispatchSemaphore(value: 0)
    writer.finishWriting { done.signal() }
    done.wait()
    guard writer.status == .completed else { fatalError("Render failed for \\(outputPath)") }
    print(outputPath)
}
`;

const swiftPath = path.join(renderDir, 'render-all.swift');
fs.writeFileSync(swiftPath, swiftSource);
execFileSync('/usr/bin/swift', [swiftPath], { stdio: 'inherit' });
console.log(`Rendered ${renderEntries.length} silent reels to ${outputDir}`);
