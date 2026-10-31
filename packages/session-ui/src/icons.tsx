/**
 * Solar 图标集 (drop-in 替代 lucide-react) —— 设计决策见 README / About 署名.
 * Icons: Solar Icon Set by 480 Design — CC BY 4.0 (https://github.com/480-Design/Solar-Icon-Set)
 * Lucide 0.564.0 original glyphs: ISC / Feather MIT; full notices in THIRD_PARTY_NOTICES.md.
 * 用法不变: import { Settings } from '@/lib/icons';  <Settings size={16} className="..." />
 *
 * 自动生成, 勿手改 —— 改 scripts/icons/solar-icons.json 后跑 `node scripts/gen-icons.mjs`.
 * 加图标: 在清单的 "solar" 栏加一行 "导出名": "<solar 图标名>", body 会从 @iconify-json/solar
 * 逐字节取来。literal 保留已有字形及固定版本的上游原图,❌ 别手绘新 path。
 * 同形别名(lucide 的 *Icon 后缀、CircleAlert/AlertCircle 这类历史改名): 写进 `alias` 栏,
 * ❌ 别在 `solar` 栏写两条指向同一个图标 —— 那会生成两份一模一样的 body。
 * 填充态: 另开一个 `*Filled` 导出取 `-bold` 字形 (HeartFilled 是样板)。
 * ❌ 别指望外层 `fill=` 覆盖 body 里写死的 fill="none", 那会静默保持空心。
 */
import { forwardRef, type SVGProps } from 'react'
import { ICON_BODIES as BODIES, ICON_ATTRIBUTES as ATTRIBUTES } from './icon-bodies'


export interface IconProps
  extends Omit<SVGProps<SVGSVGElement>, 'ref' | 'children' | 'dangerouslySetInnerHTML'> {
  size?: number | string
  /** Copied stroke glyphs honor this; Solar bodies retain their built-in line widths. */
  strokeWidth?: number | string
  absoluteStrokeWidth?: boolean
  /**
   * 图标是叶子:`<svg>` 的内容永远是 `BODIES[name]`,没有第二个出处。
   * 声明成 `never` 是为了让 `<Icon>x</Icon>` 在**编译期**就红 —— 结构上不可达,
   * 比运行时抓到更强(见本包 spec「能靠删掉越界档位让它在类型上不可达的,优先删而不是守」)。
   */
  children?: never
}

// @@@icon-swallows-children - 图标必须自己吃掉 children, 否则 Base UI 的 render 协议会打死整棵子树
//
// `children` 不属于图标的合同,但**运行期**照样会有人塞进来:Base UI 的 `render` 协议里,
// 带默认字形的 part 会无条件把自己的字形合进 render 元素 —— `select/icon/SelectIcon` 合
// `children: '▼'`,`combobox/clear` 合 `'x'`,`*/item-indicator` 合 `'✔️'`(evaluateRenderProp:
// `mergeProps(props, render.props)` + `cloneElement`,而 `render={<Icon />}` 自己没写 children,
// 那个默认字形就活下来了)。这不是调用方写错:`render={<ChevronDownIcon />}` 的语义正是
// 「用这个图标顶掉默认字形」,顶掉就意味着必须丢弃它。
//
// 所以 children 必须在**这里**被吃掉,而不是让每个调用点去绕开:`{...rest}` 一旦把它带到
// `<svg>` 上,就和 `dangerouslySetInnerHTML` 撞成 React 硬约束
// 「Can only set one of `children` or `props.dangerouslySetInnerHTML`」,
// 而 React 是**整棵子树**一起交给 error boundary —— #3504 里一个下拉框的箭头把整个会话页
// 打成一个 Reload 按钮。⚠️ 别把这条改成「在 select 那个调用点包一层 span」:
// 那只修 6 个 part × 149 个图标里的 1 个组合,下一个 `render={<Icon />}` 照样打死子树。
function makeIcon(name: string) {
  // @@@icon-body-identity - 字形对象每个图标只建一次:React 19 按引用比这个属性,换一个新对象就重写 innerHTML,
  // `<svg>` 里的 `<path>` 整个换新。按下到抬起之间重渲染一次(按下就把那块设成正看着的),按下落在旧 path、
  // 抬起落在新 path,浏览器不发 click —— 没在看的那块,点「关闭这一块」第一下没反应(#7091)。
  const html = { __html: BODIES[name] }
  const defaults = ATTRIBUTES[name]
  const Icon = forwardRef<SVGSVGElement, IconProps>(
    ({ size = 24, strokeWidth = defaults?.strokeWidth, absoluteStrokeWidth, color, className, children: _children, ...rest }, ref) => (
      <svg
        ref={ref}
        xmlns="http://www.w3.org/2000/svg"
        {...defaults}
        width={size}
        height={size}
        viewBox="0 0 24 24"
        color={color}
        stroke={defaults ? color ?? defaults.stroke : undefined}
        strokeWidth={defaults ? (absoluteStrokeWidth ? Number(strokeWidth) * 24 / Number(size) : strokeWidth) : undefined}
        className={defaults ? [defaults.className, className].filter(Boolean).join(' ').trim() : className}
        aria-hidden={defaults && Object.keys(rest).some((key) => key.startsWith('aria-') || key === 'role' || key === 'title') ? undefined : 'true'}
        {...rest}
        dangerouslySetInnerHTML={html}
      />
    )
  )
  Icon.displayName = name
  return Icon
}

/**
 * 一个图标组件的类型 —— 用来替代 lucide 的 `LucideIcon`。
 * 图标当值传递(存进映射表、按状态三元切换、当 prop 传)时标这个,
 * ❌ 别写 `typeof Folder` 反推:那会把某一个具体图标的身份焊进类型里。
 */
export type IconComponent = ReturnType<typeof makeIcon>

export const Activity = makeIcon("Activity")
export const AlertCircle = makeIcon("AlertCircle")
export const AlertTriangle = makeIcon("AlertTriangle")
export const AlignJustify = makeIcon("AlignJustify")
export const AppWindow = makeIcon("AppWindow")
export const Archive = makeIcon("Archive")
export const AreaChart = makeIcon("AreaChart")
export const ArrowBigUp = makeIcon("ArrowBigUp")
export const ArrowDown = makeIcon("ArrowDown")
export const ArrowDownToLine = makeIcon("ArrowDownToLine")
export const ArrowLeft = makeIcon("ArrowLeft")
export const ArrowRight = makeIcon("ArrowRight")
export const ArrowUp = makeIcon("ArrowUp")
export const ArrowUpRight = makeIcon("ArrowUpRight")
export const ArrowUpToLine = makeIcon("ArrowUpToLine")
export const AtSign = makeIcon("AtSign")
export const BarChart3 = makeIcon("BarChart3")
export const Bell = makeIcon("Bell")
export const BellOff = makeIcon("BellOff")
export const Bold = makeIcon("Bold")
export const BookOpen = makeIcon("BookOpen")
export const Braces = makeIcon("Braces")
export const Bug = makeIcon("Bug")
export const Cable = makeIcon("Cable")
export const CalendarClock = makeIcon("CalendarClock")
export const Check = makeIcon("Check")
export const CheckCircle2 = makeIcon("CheckCircle2")
export const Checklist = makeIcon("Checklist")
export const ChevronDown = makeIcon("ChevronDown")
export const ChevronLeft = makeIcon("ChevronLeft")
export const ChevronRight = makeIcon("ChevronRight")
export const ChevronUp = makeIcon("ChevronUp")
export const ChevronsLeft = makeIcon("ChevronsLeft")
export const ChevronsRight = makeIcon("ChevronsRight")
export const ChevronsUpDown = makeIcon("ChevronsUpDown")
export const Circle = makeIcon("Circle")
export const CircleDot = makeIcon("CircleDot")
export const CircleFadingArrowUp = makeIcon("CircleFadingArrowUp")
export const CirclePlay = makeIcon("CirclePlay")
export const Clipboard = makeIcon("Clipboard")
export const ClipboardCopy = makeIcon("ClipboardCopy")
export const Clock = makeIcon("Clock")
export const Cloud = makeIcon("Cloud")
export const Coins = makeIcon("Coins")
export const Columns2 = makeIcon("Columns2")
export const Compass = makeIcon("Compass")
export const Copy = makeIcon("Copy")
export const CornerLeftUp = makeIcon("CornerLeftUp")
export const Crown = makeIcon("Crown")
export const Database = makeIcon("Database")
export const DatabaseFilled = makeIcon("DatabaseFilled")
export const Download = makeIcon("Download")
export const Ellipsis = makeIcon("Ellipsis")
export const Eraser = makeIcon("Eraser")
export const Expand = makeIcon("Expand")
export const ExternalLink = makeIcon("ExternalLink")
export const Eye = makeIcon("Eye")
export const EyeOff = makeIcon("EyeOff")
export const File = makeIcon("File")
export const FileCode = makeIcon("FileCode")
export const FileDiff = makeIcon("FileDiff")
export const FileImage = makeIcon("FileImage")
export const FilePlus2 = makeIcon("FilePlus2")
export const FileQuestion = makeIcon("FileQuestion")
export const FileSearch = makeIcon("FileSearch")
export const FileText = makeIcon("FileText")
export const FileX = makeIcon("FileX")
export const Files = makeIcon("Files")
export const FlaskConical = makeIcon("FlaskConical")
export const Focus = makeIcon("Focus")
export const Folder = makeIcon("Folder")
export const FolderFilled = makeIcon("FolderFilled")
export const FolderInput = makeIcon("FolderInput")
export const FolderOpen = makeIcon("FolderOpen")
export const FolderPlus = makeIcon("FolderPlus")
export const Gauge = makeIcon("Gauge")
export const GitBranch = makeIcon("GitBranch")
export const GitFork = makeIcon("GitFork")
export const GitMerge = makeIcon("GitMerge")
export const GitPullRequest = makeIcon("GitPullRequest")
export const GitPullRequestArrow = makeIcon("GitPullRequestArrow")
export const GitPullRequestClosed = makeIcon("GitPullRequestClosed")
export const GitPullRequestDraft = makeIcon("GitPullRequestDraft")
export const Github = makeIcon("Github")
export const Globe = makeIcon("Globe")
export const GlobeFilled = makeIcon("GlobeFilled")
export const GripVertical = makeIcon("GripVertical")
export const HardDrive = makeIcon("HardDrive")
export const Hash = makeIcon("Hash")
export const Heart = makeIcon("Heart")
export const HeartFilled = makeIcon("HeartFilled")
export const HelpCircle = makeIcon("HelpCircle")
export const History = makeIcon("History")
export const Home = makeIcon("Home")
export const Image = makeIcon("Image")
export const Import = makeIcon("Import")
export const Info = makeIcon("Info")
export const Italic = makeIcon("Italic")
export const KeyRound = makeIcon("KeyRound")
export const Layers = makeIcon("Layers")
export const LayoutGrid = makeIcon("LayoutGrid")
export const Library = makeIcon("Library")
export const Lightbulb = makeIcon("Lightbulb")
export const Link = makeIcon("Link")
export const Link2 = makeIcon("Link2")
export const ListChecks = makeIcon("ListChecks")
export const ListFilter = makeIcon("ListFilter")
export const ListTree = makeIcon("ListTree")
export const Lock = makeIcon("Lock")
export const LogIn = makeIcon("LogIn")
export const LogOut = makeIcon("LogOut")
export const LucidePlug = makeIcon("LucidePlug")
export const Mail = makeIcon("Mail")
export const MailUnread = makeIcon("MailUnread")
export const Maximize2 = makeIcon("Maximize2")
export const MessageCircle = makeIcon("MessageCircle")
export const MessageSquare = makeIcon("MessageSquare")
export const MessageSquarePlus = makeIcon("MessageSquarePlus")
export const MessageSquareShare = makeIcon("MessageSquareShare")
export const Mic = makeIcon("Mic")
export const Minimize2 = makeIcon("Minimize2")
export const Minus = makeIcon("Minus")
export const MinusCircle = makeIcon("MinusCircle")
export const Monitor = makeIcon("Monitor")
export const MonitorSmartphone = makeIcon("MonitorSmartphone")
export const Moon = makeIcon("Moon")
export const Palette = makeIcon("Palette")
export const PaletteFilled = makeIcon("PaletteFilled")
export const PanelBottom = makeIcon("PanelBottom")
export const PanelLeft = makeIcon("PanelLeft")
export const PanelLeftClose = makeIcon("PanelLeftClose")
export const PanelLeftOpen = makeIcon("PanelLeftOpen")
export const PanelRight = makeIcon("PanelRight")
export const PanelRightClose = makeIcon("PanelRightClose")
export const PanelRightOpen = makeIcon("PanelRightOpen")
export const Paperclip = makeIcon("Paperclip")
export const Pause = makeIcon("Pause")
export const PenLine = makeIcon("PenLine")
export const Pencil = makeIcon("Pencil")
export const PieChart = makeIcon("PieChart")
export const Pin = makeIcon("Pin")
export const PinOff = makeIcon("PinOff")
export const Play = makeIcon("Play")
export const Plus = makeIcon("Plus")
export const Power = makeIcon("Power")
export const QrCode = makeIcon("QrCode")
export const Refresh = makeIcon("Refresh")
export const RefreshCw = makeIcon("RefreshCw")
export const Reply = makeIcon("Reply")
export const RotateCcw = makeIcon("RotateCcw")
export const Save = makeIcon("Save")
export const ScanSearch = makeIcon("ScanSearch")
export const Scissors = makeIcon("Scissors")
export const Search = makeIcon("Search")
export const Server = makeIcon("Server")
export const Settings = makeIcon("Settings")
export const Settings2 = makeIcon("Settings2")
export const Share = makeIcon("Share")
export const Share2 = makeIcon("Share2")
export const Shield = makeIcon("Shield")
export const ShieldAlert = makeIcon("ShieldAlert")
export const ShieldCheck = makeIcon("ShieldCheck")
export const Smile = makeIcon("Smile")
export const Sparkles = makeIcon("Sparkles")
export const SparklesFilled = makeIcon("SparklesFilled")
export const Square = makeIcon("Square")
export const SquareArrowOutUpRight = makeIcon("SquareArrowOutUpRight")
export const SquareArrowRight = makeIcon("SquareArrowRight")
export const SquareCheck = makeIcon("SquareCheck")
export const SquareDot = makeIcon("SquareDot")
export const SquareMinus = makeIcon("SquareMinus")
export const SquarePen = makeIcon("SquarePen")
export const SquarePenFilled = makeIcon("SquarePenFilled")
export const SquarePlus = makeIcon("SquarePlus")
export const SquareTerminal = makeIcon("SquareTerminal")
export const SquareX = makeIcon("SquareX")
export const Star = makeIcon("Star")
export const Sun = makeIcon("Sun")
export const Tag = makeIcon("Tag")
export const TextCursorInput = makeIcon("TextCursorInput")
export const TextInitial = makeIcon("TextInitial")
export const Trash = makeIcon("Trash")
export const Trash2 = makeIcon("Trash2")
export const TrendingUp = makeIcon("TrendingUp")
export const Underline = makeIcon("Underline")
export const Undo2 = makeIcon("Undo2")
export const Unlink = makeIcon("Unlink")
export const Unplug = makeIcon("Unplug")
export const UnplugFilled = makeIcon("UnplugFilled")
export const User = makeIcon("User")
export const UserMinus = makeIcon("UserMinus")
export const UserPlus = makeIcon("UserPlus")
export const UserRound = makeIcon("UserRound")
export const Users = makeIcon("Users")
export const WalletCards = makeIcon("WalletCards")
export const Wrench = makeIcon("Wrench")
export const X = makeIcon("X")
export const XCircle = makeIcon("XCircle")
export const Zap = makeIcon("Zap")
export const AlertCircleIcon = AlertCircle
export const AlertTriangleIcon = AlertTriangle
export const ArrowDownIcon = ArrowDown
export const ArrowLeftIcon = ArrowLeft
export const BoldIcon = Bold
export const CableIcon = Cable
export const CheckCircle = CheckCircle2
export const CheckCircle2Icon = CheckCircle2
export const CheckIcon = Check
export const ChevronDownIcon = ChevronDown
export const ChevronLeftIcon = ChevronLeft
export const ChevronRightIcon = ChevronRight
export const ChevronsUpDownIcon = ChevronsUpDown
export const ChevronUpIcon = ChevronUp
export const CircleAlert = AlertCircle
export const CircleCheck = CheckCircle2
export const CirclePlayIcon = CirclePlay
export const ClipboardCopyIcon = ClipboardCopy
export const Clock3 = Clock
export const CopyIcon = Copy
export const DownloadIcon = Download
export const FileX2 = FileX
export const FolderClosed = Folder
export const GithubIcon = Github
export const ImageIcon = Image
export const InfoIcon = Info
export const ItalicIcon = Italic
export const LinkIcon = Link
export const Loader2 = Ellipsis
export const Loader2Icon = Ellipsis
export const LoaderCircle = Ellipsis
export const MoreHorizontal = Ellipsis
export const MoreHorizontalIcon = Ellipsis
export const PencilIcon = Pencil
export const Plug = Unplug
export const PlugFilled = UnplugFilled
export const PlusIcon = Plus
export const RefreshCcw = RefreshCw
export const RefreshCwIcon = RefreshCw
export const Reload = RefreshCw
export const ScissorsIcon = Scissors
export const SearchIcon = Search
export const ServerIcon = Server
export const ShieldAlertIcon = ShieldAlert
export const Terminal = SquareTerminal
export const Trash2Icon = Trash2
export const TrashIcon = Trash
export const TriangleAlert = AlertTriangle
export const UnderlineIcon = Underline
export const XIcon = X
