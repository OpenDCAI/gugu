import { makeAutoObservable, observable } from 'mobx';

class ModalStore {
  activeModalId: string | null = null;
  // oxlint-disable-next-line typescript/no-explicit-any
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

  // oxlint-disable-next-line typescript/no-explicit-any
  setModal(id: string, args: Record<string, any>) {
    this.previousFocus = document.activeElement as HTMLElement | null;
    this.activeModalId = id;
    this.activeModalArgs = args;
  }

  closeModal(_outcome: 'completed' | 'dismissed' = 'dismissed') {
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
