import { LoadingIndicator } from '@/lib/loading/LoadingIndicator'

import { isWindowsHost } from '@shared/host-os';
import { useState } from 'react';
import type { HostDependencyInstallation } from '@renderer/lib/stores/use-agent-installation-statuses';
import { Input } from '@renderer/lib/ui/input';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import type { Installation } from '@shared/core/agents/agent-payload';
import { Button } from '@renderer/lib/ui/button';
import { looksLikeAbsolutePath } from './installation-sources';

export type InstallationOverrideCardProps = {
  vm: HostDependencyInstallation;
  /** Initial value from persisted selection, if any. */
  initialValue?: string;
  /** 探测中。给了就回报,调用方据此禁用别的东西;不给就不报。 */
  onChecking?: (isChecking: boolean) => void;
  /** Called with the probe result once Validate completes (null means probeOverride returned nothing). */
  onResolved: (installation: Installation | null) => void;
  /** 关掉这一格,不改动已经存下的那份选择。给了才渲染「取消」。 */
  onCancel?: () => void;
};

/**
 * 「手动指定」。
 *
 * ❌ 不再由父组件传 `kind` —— 界面上「指定路径」和「指定命令」已经合成一条,是**填的内容**
 * 决定按哪种处理:绝对路径 → 校验存在、找不到回落到自动;命令名 → 原样交给 PATH。这条差别
 * 用户没法从两个菜单项的名字里读出来,所以当场写在输入框下面。#4271
 */
export function InstallationOverrideCard({
  vm,
  initialValue = '',
  onChecking,
  onResolved,
  onCancel,
}: InstallationOverrideCardProps) {
  const [value, setValue] = useState(initialValue);
  const [isChecking, setIsChecking] = useState(false);
  /**
   * 探测回来说这个目标用不了。
   *
   * ❌ 之前点「使用」探到 `status !== 'available'` 时,父组件直接 return,界面上**什么都不发生**
   * —— 用户看到的是一个按了没反应的按钮,只能以为是产品坏了。判断不出就如实说。#4271
   */
  const [error, setError] = useState<string | null>(null);
  const { translate } = useSessionMessages();

  /* @@@raw example — 路径与命令名是真实形态,不翻译;把它们连起来的那个「或」是句子,走词表
     (从前它是写死的中文,英文壳下这行占位符里就冒出一个汉字)。两种平台各给一个样子。 */
  const or = `    ${translate('agentsPage.manualPlaceholderOr')}    `;
  const placeholder = isWindowsHost()
    ? `C:\\Users\\you\\AppData\\Roaming\\npm\\claude.cmd${or}claude`
    : `/usr/local/bin/claude${or}claude`;

  const handleValidate = async () => {
    setIsChecking(true);
    onChecking?.(true);
    try {
      const selection = isPath ? { path: value } : { cli: value };
      const result = await vm.probeOverride(selection);
      setError(
        result?.status === 'available'
          ? null
          : translate(isPath ? 'agentsPage.manualPathNotFound' : 'agentsPage.manualCommandNotFound'),
      );
      onResolved(result ?? null);
    } finally {
      setIsChecking(false);
      onChecking?.(false);
    }
  };

  const trimmed = value.trim();
  const hasValue = trimmed.length > 0;
  const isPath = looksLikeAbsolutePath(trimmed);

  return (
    // 「自定义路径」那一行里展开的输入格:输入框与按钮同一行,说明在下面一行。
    // ❌ 不再左缩进 `pl-10`、不再把按钮单独放一行 —— owner 截图里那块歪着的就是它。
    <div className="flex flex-col gap-1.5 pt-1">
      <div className="flex min-w-0 items-center gap-2">
        {/* @@@raw example — 覆盖输入的示例是真实路径/命令形态,不翻译。 */}
        <Input
          data-testid="manual-override-input"
          autoFocus
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && hasValue && !isChecking) void handleValidate();
            if (e.key === 'Escape' && onCancel) onCancel();
          }}
          placeholder={placeholder}
          className="min-w-0 flex-1 font-mono text-sm"
          disabled={isChecking}
        />
        <Button size="sm" disabled={isChecking || !hasValue} onClick={() => void handleValidate()}>
          {isChecking && <LoadingIndicator size="inline" />}
          {translate('agentsPage.validate')}
        </Button>
        {onCancel && (
          <Button size="sm" variant="outline" disabled={isChecking} onClick={onCancel}>
            {translate('agentsPage.cancel')}
          </Button>
        )}
      </div>
      {/* 中性说明(「你填的会被当成什么处理」),出错时才变红。#4271 */}
      <p className={`m-0 text-sm ${error ? 'text-foreground-destructive' : 'text-foreground-muted'}`}>
        {error ??
          (!hasValue
            ? translate('agentsPage.manualEitherMode')
            : isPath
              ? translate('agentsPage.manualPathMode')
              : translate('agentsPage.manualCommandMode'))}
      </p>
    </div>
  );
}
