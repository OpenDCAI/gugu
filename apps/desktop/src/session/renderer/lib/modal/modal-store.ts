import { makeAutoObservable, observable } from 'mobx';
import { noteOverlayRequest } from '@/lib/localRendererDiagnostics';

class ModalStore {
  activeModalId: string | null = null;
  activeModalArgs: Record<string, any> | null = null;
  closeGuardActive = false;
  previousFocus: HTMLElement | null = null;
  /**
   * 弹窗落在哪。缺省(null)= 本页的浮层层;壳的设置弹窗画着会话页那几格时,改落进那个弹窗**里面**
   * (product spec:浏览器页「清除数据」的确认框要浮在设置弹窗之上、点得到)。画它的仍是本页 App 里那一个
   * ModalRenderer —— 弹窗内容要用本页树里的 context,❌ 在设置弹窗里再挂第二个。
   */
  portalContainer: HTMLElement | null = null;

  constructor() {
    makeAutoObservable(this, {
      activeModalArgs: observable.ref,
      previousFocus: observable.ref,
      portalContainer: observable.ref,
    });
  }

  setModal(id: string, args: Record<string, any>) {
    noteOverlayRequest(null, 'session-modal', true);
    if (this.activeModalId !== id) {
      this.previousFocus = document.activeElement as HTMLElement | null;
    }
    this.activeModalId = id;
    this.activeModalArgs = args;
  }

  /**
   * @@@modal-focus-return — 焦点只在弹窗被**关掉**(Esc / 点外面 / 取消)时还给打开它的元素:人还在原处,键盘接着走。
   * 弹窗**做完了事**(选了一条结果、执行了命令、确认了)时不还:人已经被带去别处,焦点归那里。还回去会让
   * 打开它的按钮带着键盘焦点环挂在一个人已经离开的地方(搜索框回车打开结果后那圈蓝框),还会抢走动作自己落下的焦点。
   */
  closeModal(outcome: 'completed' | 'dismissed' = 'dismissed') {
    noteOverlayRequest(null, 'session-modal', false);
    if (outcome === 'completed') this.previousFocus = null;
    this.closeGuardActive = false;
    this.activeModalId = null;
    this.activeModalArgs = null;
  }

  setPortalContainer(container: HTMLElement | null) {
    this.portalContainer = container;
  }

  get isOpen(): boolean {
    return this.activeModalId !== null;
  }
}

export const modalStore = new ModalStore();
