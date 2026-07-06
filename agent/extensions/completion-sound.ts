import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

export default function (pi: ExtensionAPI) {
  // 配置选项
  const config = {
    enabled: true,
    // macOS 系统音效名称，可选：Glass, Ping, Pop, Purr, Tink, etc.
    systemSound: "Hero",
    // ask_user_question 弹出时的音效
    questionSound: "Funk",
    // permission 确认时的音效（高风险操作）
    permissionSound: "Frog",
    // 或者使用自定义音频文件路径（优先级高于系统音效）
    customSoundPath: undefined as string | undefined,
    customQuestionSoundPath: undefined as string | undefined,
    customPermissionSoundPath: undefined as string | undefined,
    // 是否只在较长的响应后播放（避免短回复频繁播放）
    minDurationMs: 2000,
  };

  let agentStartTime: number | null = null;

  // 记录开始时间
  pi.on("agent_start", async (_event, _ctx) => {
    agentStartTime = Date.now();
  });

  // 在 agent 完成时播放提示音
  pi.on("agent_end", async (_event, _ctx) => {
    if (!config.enabled) return;

    // 检查是否满足最小时长要求
    if (agentStartTime && config.minDurationMs > 0) {
      const duration = Date.now() - agentStartTime;
      if (duration < config.minDurationMs) {
        return;
      }
    }

    await playSound(config.systemSound, config.customSoundPath);
  });

  // 注册命令来切换提示音
  pi.registerCommand("sound", {
    description: "Toggle completion sound on/off",
    handler: async (_args, ctx) => {
      config.enabled = !config.enabled;
      ctx.ui.notify(
        `Completion sound ${config.enabled ? "enabled" : "disabled"}`,
        "info"
      );
    },
  });

  // 播放音效的辅助函数
  async function playSound(soundName: string, customPath?: string) {
    try {
      if (customPath) {
        await execAsync(`afplay "${customPath}"`);
      } else {
        await execAsync(`afplay "/System/Library/Sounds/${soundName}.aiff"`);
      }
    } catch (error) {
      // 静默失败，避免干扰正常使用
    }
  }

  // 监听工具调用，检测需要提示的场景
  pi.on("tool_call", async (event, _ctx) => {
    if (!config.enabled) return;
    
    // ask_user_question 弹出时
    if (event.toolName === "ask_user_question") {
      await playSound(config.questionSound, config.customQuestionSoundPath);
      return;
    }
    
    // 检测高风险 bash 命令（可能触发 permission 确认）
    if (event.toolName === "bash" && event.input && typeof event.input.command === "string") {
      const cmd = event.input.command.toLowerCase();
      const riskyPatterns = [
        /\brm\s+-rf\b/,
        /\brm\s+-r\b/,
        /\bsudo\b/,
        /\bdd\s+if=/,
        /\bcurl.*\|.*bash/,
        /\bwget.*\|.*bash/,
        /\bchmod\s+777/,
        /\bmkfs\./,
        /\bgit\s+push/,
      ];
      
      if (riskyPatterns.some(pattern => pattern.test(cmd))) {
        await playSound(config.permissionSound, config.customPermissionSoundPath);
      }
    }
  });

  // 显示启动提示
  pi.on("session_start", async (_event, ctx) => {
    if (config.enabled) {
      ctx.ui.notify("🔔 Completion sound enabled", "info");
    }
  });
}
