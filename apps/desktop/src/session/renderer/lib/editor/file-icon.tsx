import { File, FileImage } from '@/lib/icons'
import { resolveFileIconClass } from '@gugu/session-chat-ui/file-icons'

/**
 * The devicon class for a file, from the one map chat uses (`resolveFileIconClass`).
 *
 * @@@chrome-is-ink (Refs #6106) — ❌ 别在这里留 devicon 的 `colored`:它才是上品牌色的那个类
 * (`devicon.min.css`:`.devicon-rust-original.colored{color:#000}`),色值写死、不随主题走。
 * 不带 `colored` 时 devicon 继承 `currentColor` ⇒ 跟着宿主的墨色走,身份区分交给字形本身。
 */
const inkIconClass = (filename: string) => resolveFileIconClass(filename)?.replace(/\s*\bcolored\b/, '')

/**
 * @@@chrome-is-ink (Refs #6106) — 图片扩展名 → 无障碍标签。
 *
 * 原来每一格还带一个 `text-sky-500` / `text-fuchsia-500` 之类的品牌彩色 className，
 * 七个扩展名七种颜色。文件树是会话页同屏密度最大的常驻表面，彩色在这里不是信息、是噪音
 * （owner 在 `lib/components/titlebar/open-in-menu.tsx` 上已就「常驻触发位不许彩色图标」
 * 拍过同一条；2026-09-22 按 design.md「Chrome is ink」把它传导到文件树）。
 * 去掉颜色之后这张表只剩标签 ⇒ 整格收成 `扩展名 → 标签`。
 */
const IMAGE_ICON_LABELS: Record<string, string> = {
  png: 'PNG',
  jpg: 'JPG',
  jpeg: 'JPG',
  gif: 'GIF',
  webp: 'WEBP',
  svg: 'SVG',
  bmp: 'BMP',
  ico: 'ICO',
};

function getExtension(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot >= 0 ? filename.slice(dot + 1).toLowerCase() : '';
}

interface FileIconProps {
  filename: string;
  className?: string;
  size?: number;
}

export function FileIcon({ filename, className, size = 12 }: FileIconProps) {
  const extension = getExtension(filename);
  const deviconClass = inkIconClass(filename);

  if (deviconClass) {
    return (
      <i className={deviconClass} style={{ fontSize: size, lineHeight: 1 }} aria-hidden="true" />
    );
  }

  const imageLabel = IMAGE_ICON_LABELS[extension];
  if (imageLabel) {
    // 原来这里还在图标右下角压一枚 6px 的扩展名角标。6px 不在任何字阶上、也在可读区间之外，
    // 而它标的东西（PNG / SVG …）**文件名自己已经写着了**，title 也还带着 —— 删掉不丢信息。
    return (
      <span
        className="inline-flex shrink-0 items-center justify-center"
        style={{ width: size, height: size }}
        title={`${imageLabel} image`}
      >
        <FileImage
          className={className ?? 'shrink-0'}
          style={{ width: size, height: size }}
          aria-hidden="true"
        />
      </span>
    );
  }

  return (
    <File
      className={className ?? 'shrink-0 text-foreground-passive'}
      style={{ width: size, height: size }}
      aria-hidden="true"
    />
  );
}
