import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { bootstrapAcpRuntimeBackends } from "../../acp/runtime/bootstrap";
import type { MoziConfig } from "../../config";
import { configureLogger, logger } from "../../logger";
import { initDb } from "../../storage/db";
import { DiscordPlugin } from "../adapters/channels/discord/plugin";
import { LocalDesktopPlugin } from "../adapters/channels/local-desktop/plugin";
import { ChannelRegistry } from "../adapters/channels/registry";
import { TelegramPlugin } from "../adapters/channels/telegram/plugin";
import type { InboundMessage } from "../adapters/channels/types";
import {
  ensureChromeExtensionRelayServer,
  stopAllChromeExtensionRelays,
} from "../browser/extension-relay";
import { RuntimeKernel } from "../core/kernel";
import { AgentJobDelivery, AgentJobRunner, InMemoryAgentJobRegistry } from "../jobs";
import { bootstrapSandboxes } from "../sandbox/bootstrap";
import { ConfigManager } from "./config-manager";
import { CronScheduler } from "./cron/scheduler";
import type { CronJob } from "./cron/types";
import { HealthCheck } from "./health";
import { HeartbeatRunner } from "./heartbeat";
import { Lifecycle } from "./lifecycle";
import { resolveLocalDesktopDecision } from "./local-desktop-mode";
import { MessageHandler } from "./message-handler";
import { ReminderRunner } from "./reminders/runner";
import { routeContextToOutboundMessage } from "./routing/route-context";
import { SessionManager } from "./sessions/manager";
import { SubAgentRegistry as SessionSubAgentRegistry } from "./sessions/spawn";
import { injectMessageHandler } from "./sessions/subagent-announce";
import type { RuntimeHostOptions, RuntimeStatus } from "./types";

export class RuntimeHost {
  private running = false;
  private startedAt: Date | null = null;
  private configManager: ConfigManager;
  private health: HealthCheck;
  private sessionManager: SessionManager;
  private subAgentRegistry: SessionSubAgentRegistry;
  private channelRegistry: ChannelRegistry;
  private runtimeKernel: RuntimeKernel | null = null;
  private messageHandler: MessageHandler | null = null;
  private cronScheduler: CronScheduler | null = null;
  private heartbeatRunner: HeartbeatRunner | null = null;
  private reminderRunner: ReminderRunner | null = null;
  private agentJobRegistry: InMemoryAgentJobRegistry | null = null;
  private agentJobRunner: AgentJobRunner | null = null;
  private pendingMessageHandlerReload: MoziConfig | null = null;
  private reloadDrainTimer: ReturnType<typeof setTimeout> | null = null;

  private async enqueueInboundMessage(msg: InboundMessage): Promise<void> {
    if (!this.runtimeKernel) {
      return;
    }
    await this.runtimeKernel
      .enqueueInbound({
        id: msg.id,
        inbound: msg,
        receivedAt: msg.timestamp instanceof Date ? msg.timestamp : new Date(),
      })
      .then((result) => {
        logger.info(
          {
            channel: msg.channel,
            peerId: msg.peerId,
            messageId: msg.id,
            queueItemId: result.queueItemId,
            sessionKey: result.sessionKey,
            accepted: result.accepted,
            deduplicated: result.deduplicated,
          },
          "Inbound enqueue result",
        );
      })
      .catch((err) => {
        logger.error({ err }, "Error handling inbound message");
      });
  }

  constructor(private options: RuntimeHostOptions = {}) {
    this.configManager = new ConfigManager();
    this.health = new HealthCheck();
    this.sessionManager = new SessionManager();
    this.subAgentRegistry = new SessionSubAgentRegistry(path.join(process.cwd(), "data"));
    this.channelRegistry = new ChannelRegistry();

    this.configManager.on("change", (config) => {
      configureLogger(config.logging?.level);
      logger.info("Runtime detected configuration change");
      void this.runAutoSandboxBootstrap(config).catch((error) => {
        logger.warn(
          { err: error },
          "Sandbox auto-bootstrap failed during config reload; continuing with existing runtime.",
        );
      });
      void this.startBrowserRelayIfNeeded(config).catch((error) => {
        logger.warn(
          { err: error },
          "Browser relay init failed during config reload; continuing with existing runtime.",
        );
      });
      void this.scheduleSafeMessageHandlerReload(config).catch((error) => {
        logger.warn(
          { err: error },
          "MessageHandler reload failed during config change; continuing with existing state.",
        );
      });
      void this.runSandboxProbe("reload");
    });
  }

  async start(): Promise<void> {
    if (this.running) {
      return;
    }

    logger.info("Starting Mozi Runtime...");

    // 1. Check for existing instance and write PID
    try {
      Lifecycle.writePid();
    } catch (error) {
      logger.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }

    // 2. Initialize config
    try {
      await this.configManager.load();
      this.configManager.watch();
      logger.info("Configuration loaded and watching for changes");
    } catch (error) {
      logger.error(
        `Failed to load configuration: ${error instanceof Error ? error.message : String(error)}`,
      );
      process.exit(1);
    }

    // 3. Initialize database
    const loadedConfig = this.configManager.getAll();
    configureLogger(loadedConfig.logging?.level);
    await this.runAutoSandboxBootstrap(loadedConfig);
    await this.startBrowserRelayIfNeeded(loadedConfig);

    // 3.5. Bootstrap ACP runtime backends
    try {
      await bootstrapAcpRuntimeBackends(loadedConfig);
    } catch (error) {
      logger.warn(
        { err: error },
        "ACP runtime backend bootstrap failed; ACP features may not be available.",
      );
    }

    // 4. Initialize database
    try {
      const baseDir = loadedConfig.paths?.baseDir;
      const dbPath = baseDir ? path.join(baseDir, "mozi.db") : undefined;
      initDb(dbPath);
      logger.info("Database initialized");
    } catch (error) {
      logger.error(
        `Failed to initialize database: ${error instanceof Error ? error.message : String(error)}`,
      );
      process.exit(1);
    }

    // 5. Initialize Session Manager
    try {
      await this.sessionManager.load();
      logger.info("Session Manager initialized");
    } catch (error) {
      logger.error(
        `Failed to initialize Session Manager: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    // 6. Initialize Channels
    const config = loadedConfig;
    await this.reloadMessageHandler(config);
    if (this.runtimeKernel) {
      await this.runtimeKernel.start();
      if (this.reminderRunner) {
        this.reminderRunner.start();
      }
    }
    await this.runSandboxProbe("startup");

    await this.initializeChannels();

    if (this.heartbeatRunner) {
      this.heartbeatRunner.start(config);
    }

    // 7. Initialize Cron Scheduler
    await this.initializeCron();

    // 8. Setup Health Checks
    this.setupHealthChecks();
    await this.health.check();
    this.health.startLoop(30000); // 30s interval

    const results = this.health.getResults();
    if (this.health.isHealthy()) {
      logger.info("Health check: all components healthy");
    } else {
      for (const result of results) {
        if (result.status !== "healthy") {
          logger.warn(
            `Health check: component ${result.name} is ${result.status} - ${typeof result.details?.error === "string" ? result.details.error : "no details"}`,
          );
        }
      }
      logger.warn("Health check: some components are not healthy");
    }

    this.running = true;
    this.startedAt = new Date();

    logger.info(`Mozi Runtime started (PID: ${process.pid})`);

    // Enter main loop (keep process alive)
    if (this.options.daemon) {
      logger.info("Runtime running in daemon mode");
    }

    this.keepAlive();
  }

  private async reloadMessageHandler(config: MoziConfig): Promise<void> {
    if (this.messageHandler) {
      await this.messageHandler.reloadConfig(config);
    } else {
      this.messageHandler = new MessageHandler(config, {
        sessionManager: this.sessionManager,
        subAgentRegistry: this.subAgentRegistry,
        runtimeControl: {
          getStatus: () => this.getStatus(),
          restart: async () => {
            await this.reload();
          },
        },
      });
      injectMessageHandler(this.messageHandler);
      await this.messageHandler.initExtensions();
      await this.subAgentRegistry.reconcileOrphanedRuns();
      logger.info("MessageHandler initialized");
    }

    const messageHandler = this.messageHandler;
    if (!messageHandler) {
      throw new Error("MessageHandler not initialized");
    }

    if (!this.agentJobRegistry) {
      this.agentJobRegistry = new InMemoryAgentJobRegistry({
        snapshotTtlMs: config.runtime?.agentJobs?.snapshotTtlMs,
      });
    }

    if (!this.agentJobRunner) {
      const jobDelivery = new AgentJobDelivery({
        registry: this.agentJobRegistry,
        retries: config.runtime?.agentJobs?.deliveryRetries ?? 0,
        dispatch: {
          send: async ({ delivery, replyText }) => {
            const channelId = delivery.route.channelId;
            const peerId = delivery.route.peerId;
            const channel = this.channelRegistry.get(channelId);
            if (!channel) {
              throw new Error(`Channel not found: ${channelId}`);
            }
            const outbound = routeContextToOutboundMessage(delivery.route, {
              text: replyText ?? "",
              traceId: delivery.traceId,
            });
            return channel.send(peerId, outbound);
          },
        },
      });
      this.agentJobRunner = new AgentJobRunner({
        registry: this.agentJobRegistry,
        delivery: jobDelivery,
        executePrompt: async ({ sessionKey, agentId, text, traceId, abortSignal, onStream }) => {
          await messageHandler.runAgentJobPrompt({
            sessionKey,
            agentId,
            text,
            traceId,
            abortSignal,
            onStream,
          });
        },
      });
    }

    this.runtimeKernel = new RuntimeKernel({
      messageHandler,
      sessionManager: this.sessionManager,
      channelRegistry: this.channelRegistry,
      queueConfig: config.runtime?.queue,
      agentJobRunner: this.agentJobRunner,
      agentJobRegistry: this.agentJobRegistry,
    });

    if (!this.reminderRunner) {
      this.reminderRunner = new ReminderRunner(this.runtimeKernel, 1000, 32, {
        jobRunner: this.agentJobRunner,
        jobRegistry: this.agentJobRegistry,
      });
    }

    if (!this.heartbeatRunner) {
      this.heartbeatRunner = new HeartbeatRunner(
        messageHandler,
        messageHandler.getAgentManager(),
        async (msg: InboundMessage) => {
          await this.enqueueInboundMessage(msg);
        },
      );
    }
    this.heartbeatRunner.updateConfig(config);
  }

  private async scheduleSafeMessageHandlerReload(config: MoziConfig): Promise<void> {
    this.pendingMessageHandlerReload = config;
    if (this.reloadDrainTimer) {
      return;
    }

    const tryDrain = async (): Promise<void> => {
      if (!this.pendingMessageHandlerReload) {
        return;
      }
      const activePrompts = this.messageHandler?.getActivePromptRunCount() ?? 0;
      if (activePrompts > 0) {
        logger.info(
          { activePrompts },
          "Deferring MessageHandler reload until active prompt runs are drained",
        );
        this.reloadDrainTimer = setTimeout(() => {
          this.reloadDrainTimer = null;
          void tryDrain();
        }, 300);
        return;
      }

      const next = this.pendingMessageHandlerReload;
      this.pendingMessageHandlerReload = null;
      await this.reloadMessageHandler(next);
    };

    await tryDrain();
  }

  private async startBrowserRelayIfNeeded(config: MoziConfig): Promise<void> {
    const browser = config.browser;
    if (!browser?.relay?.enabled) {
      return;
    }
    const defaultProfile = browser.defaultProfile;
    if (!defaultProfile) {
      return;
    }
    const profile = browser.profiles?.[defaultProfile];
    if (!profile || profile.driver !== "extension") {
      return;
    }

    // Start relay: use explicit cdpUrl if provided, otherwise use relay.port
    await ensureChromeExtensionRelayServer({
      cdpUrl: profile.cdpUrl,
      config,
      bindHost: browser.relay?.bindHost,
      port: profile.cdpUrl ? undefined : browser.relay?.port,
    });
  }

  private async runSandboxProbe(reason: "startup" | "reload"): Promise<void> {
    if (!this.messageHandler) {
      return;
    }
    const reports = await this.messageHandler.getAgentManager().probeSandboxes();
    if (reports.length === 0) {
      return;
    }
    for (const report of reports) {
      const log = {
        reason,
        agentId: report.agentId,
        mode: report.result.mode,
        hints: report.result.hints,
      };
      if (report.result.ok) {
        logger.info(log, report.result.message);
      } else {
        logger.warn(log, report.result.message);
      }
    }
  }

  private async runAutoSandboxBootstrap(config: MoziConfig): Promise<void> {
    const result = await bootstrapSandboxes(config, {
      fix: true,
      onlyAutoEnabled: true,
    });
    if (result.attempted === 0) {
      return;
    }
    for (const action of result.actions) {
      logger.info(
        { agentId: action.agentId, mode: action.mode, startupPhase: "bootstrap" },
        action.message,
      );
    }
    for (const issue of result.issues) {
      const log = {
        agentId: issue.agentId,
        mode: issue.mode,
        hints: issue.hints,
        startupPhase: "bootstrap",
      };
      if (issue.level === "error") {
        logger.error(log, issue.message);
      } else {
        logger.warn(log, issue.message);
      }
    }
    if (!result.ok) {
      throw new Error("Sandbox bootstrap failed during startup.");
    }
  }

  private async initializeChannels(): Promise<void> {
    const config = this.configManager.getAll();
    const telegramConfig = config.channels?.telegram;
    const discordConfig = config.channels?.discord;

    // Initialize Telegram if configured
    if (telegramConfig?.enabled === true && !telegramConfig.botToken) {
      logger.warn("Telegram channel is enabled but botToken is missing; skipping initialization.");
    }
    if (telegramConfig?.enabled !== false && telegramConfig?.botToken) {
      try {
        const telegram = new TelegramPlugin({
          botToken: telegramConfig.botToken,
          allowedChats: telegramConfig.allowedChats,
          dmPolicy: telegramConfig.dmPolicy,
          groupPolicy: telegramConfig.groupPolicy,
          allowFrom: telegramConfig.allowFrom,
          groups: telegramConfig.groups,
          streamMode: telegramConfig.streamMode,
          polling: telegramConfig.polling,
          statusReactions: telegramConfig.statusReactions,
        });

        // Handle incoming messages
        telegram.on("message", (msg) => {
          logger.info(
            { from: msg.peerId, text: msg.text?.slice(0, 50) },
            "Received Telegram message",
          );
          void this.enqueueInboundMessage(msg);
        });

        this.channelRegistry.register(telegram);
        await telegram.connect();
        logger.info("Telegram channel connected");
      } catch (error) {
        logger.error(
          `Failed to initialize Telegram: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    // Initialize Discord if configured
    if (discordConfig?.enabled === true && !discordConfig.botToken) {
      logger.warn("Discord channel is enabled but botToken is missing; skipping initialization.");
    }
    if (discordConfig?.enabled !== false && discordConfig?.botToken) {
      try {
        const discord = new DiscordPlugin({
          botToken: discordConfig.botToken,
          allowedGuilds: discordConfig.allowedGuilds,
          allowedChannels: discordConfig.allowedChannels,
          dmPolicy: discordConfig.dmPolicy,
          groupPolicy: discordConfig.groupPolicy,
          allowFrom: discordConfig.allowFrom,
          guilds: discordConfig.guilds,
          statusReactions: discordConfig.statusReactions,
        });

        // Handle incoming messages
        discord.on("message", (msg) => {
          logger.info(
            { from: msg.peerId, text: msg.text?.slice(0, 50) },
            "Received Discord message",
          );
          void this.enqueueInboundMessage(msg);
        });

        this.channelRegistry.register(discord);
        await discord.connect();
        logger.info("Discord channel connected");
      } catch (error) {
        logger.error(
          `Failed to initialize Discord: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    const localDesktopDecision = resolveLocalDesktopDecision(config);
    logger.info(
      {
        mode: localDesktopDecision.mode,
        source: localDesktopDecision.source,
        enabled: localDesktopDecision.enabled,
        reason: localDesktopDecision.reason,
      },
      "Local desktop widget startup decision",
    );

    if (localDesktopDecision.enabled) {
      try {
        const localDesktopConfig = config.channels?.localDesktop;
        const localDesktop = new LocalDesktopPlugin({
          enabled: true,
          host: localDesktopConfig?.host,
          port: localDesktopConfig?.port,
          authToken: localDesktopConfig?.authToken,
          allowOrigins: localDesktopConfig?.allowOrigins,
          widget: localDesktopConfig?.widget,
          voice: config.voice,
        });

        localDesktop.on("message", (msg) => {
          logger.info(
            { from: msg.peerId, text: msg.text?.slice(0, 50) },
            "Received local desktop message",
          );
          void this.enqueueInboundMessage(msg);
        });

        this.channelRegistry.register(localDesktop);
        await localDesktop.connect();
        logger.info("Local desktop channel connected");
      } catch (error) {
        logger.error(
          {
            err: error,
            mode: localDesktopDecision.mode,
            source: localDesktopDecision.source,
          },
          "Failed to initialize local desktop. Set channels.localDesktop.widget.mode='off' to disable or fix desktop environment.",
        );
      }
    } else {
      logger.info(
        {
          mode: localDesktopDecision.mode,
          source: localDesktopDecision.source,
          reason: localDesktopDecision.reason,
        },
        "Local desktop widget disabled",
      );
    }
  }

  private async initializeCron(): Promise<void> {
    const config = this.configManager.getAll();
    const runtimeCron = config.runtime?.cron;
    const legacyCron = (config as unknown as { cron?: { jobs?: unknown[] } }).cron;
    const cronConfig = runtimeCron ?? legacyCron;
    const rawJobs = Array.isArray(cronConfig?.jobs) ? cronConfig.jobs : [];

    if (!rawJobs.length) {
      logger.debug("No cron jobs configured");
      return;
    }

    this.cronScheduler = new CronScheduler(this.channelRegistry);

    // Add jobs from config
    for (const rawJobConfig of rawJobs) {
      if (!rawJobConfig || typeof rawJobConfig !== "object") {
        continue;
      }
      const jobConfig = rawJobConfig as {
        id?: string;
        name?: string;
        schedule?: CronJob["schedule"];
        payload?: CronJob["payload"];
        enabled?: boolean;
      };
      if (!jobConfig.id || !jobConfig.schedule || !jobConfig.payload) {
        continue;
      }
      const job: CronJob = {
        id: jobConfig.id,
        name: jobConfig.name,
        schedule: jobConfig.schedule,
        payload: jobConfig.payload,
        enabled: jobConfig.enabled !== false,
        createdAt: new Date(),
      };
      this.cronScheduler.add(job);
      logger.info({ jobId: job.id, nextRun: job.nextRunAt }, "Cron job scheduled");
    }

    this.cronScheduler.start();
    logger.info(`Cron scheduler started with ${rawJobs.length} jobs`);
  }

  private setupHealthChecks() {
    // Database check
    this.health.register("database", async () => {
      const baseDir = this.configManager.getAll().paths?.baseDir;
      const dbPath = baseDir ? path.join(baseDir, "mozi.db") : "data/mozi.db";
      const exists = fs.existsSync(dbPath);
      if (!exists) {
        return {
          name: "database",
          status: "unhealthy",
          lastCheck: new Date(),
          details: { error: "Database file missing" },
        };
      }
      try {
        // Try a simple query
        const db = new Database(dbPath);
        db.prepare("SELECT 1").get();
        db.close();
        return {
          name: "database",
          status: "healthy",
          lastCheck: new Date(),
        };
      } catch (error) {
        return {
          name: "database",
          status: "unhealthy",
          lastCheck: new Date(),
          details: {
            error: error instanceof Error ? error.message : String(error),
          },
        };
      }
    });

    // Config check
    this.health.register("config", async () => {
      try {
        const config = this.configManager.getAll();
        return {
          name: "config",
          status: config ? "healthy" : "degraded",
          lastCheck: new Date(),
        };
      } catch (error) {
        return {
          name: "config",
          status: "unhealthy",
          lastCheck: new Date(),
          details: {
            error: error instanceof Error ? error.message : String(error),
          },
        };
      }
    });

    // Channels check
    this.health.register("channels", async () => {
      const channels = this.channelRegistry.list();
      const connected = channels.filter((c) => c.getStatus() === "connected");
      return {
        name: "channels",
        status: connected.length > 0 ? "healthy" : "degraded",
        lastCheck: new Date(),
        details: {
          total: channels.length,
          connected: connected.length,
        },
      };
    });
  }

  async stop(exitCode = 0): Promise<void> {
    if (!this.running) {
      return;
    }

    logger.info("Shutting down...");

    // 1. Disconnect channels
    for (const channel of this.channelRegistry.list()) {
      try {
        const plugin = this.channelRegistry.get(channel.id);
        if (plugin) {
          await plugin.disconnect();
        }
      } catch (error) {
        logger.warn(`Error disconnecting ${channel.id}: ${String(error)}`);
      }
    }

    // 2. Stop cron scheduler
    if (this.cronScheduler) {
      this.cronScheduler.stop();
    }

    // 2b. Stop heartbeat runner
    if (this.heartbeatRunner) {
      this.heartbeatRunner.stop();
    }
    if (this.runtimeKernel) {
      await this.runtimeKernel.stop();
    }
    if (this.reminderRunner) {
      this.reminderRunner.stop();
    }
    if (this.messageHandler) {
      await this.messageHandler.shutdownExtensions();
    }
    try {
      await stopAllChromeExtensionRelays();
    } catch (error) {
      logger.warn({ err: error }, "Failed to stop browser relay servers; continuing shutdown.");
    }
    if (this.reloadDrainTimer) {
      clearTimeout(this.reloadDrainTimer);
      this.reloadDrainTimer = null;
    }

    // 3. Cleanup resources
    this.configManager.stopWatch();
    this.health.stopLoop();

    // 3. Remove PID file
    Lifecycle.removePid();

    this.running = false;
    this.startedAt = null;

    logger.info("Mozi Runtime stopped cleanly.");
    process.exit(exitCode);
  }

  async reload(): Promise<void> {
    await this.configManager.reload();
  }

  getStatus(): RuntimeStatus {
    return {
      running: this.running,
      pid: this.running ? process.pid : null,
      uptime: this.startedAt ? Math.floor((Date.now() - this.startedAt.getTime()) / 1000) : 0,
      startedAt: this.startedAt,
      health: {
        overall: this.health.getOverallStatus(),
        components: this.health.getResults(),
      },
      sessions: {
        total: this.sessionManager.list().length,
        active: this.sessionManager.list({ status: "running" }).length,
        queued: this.sessionManager.list({ status: "queued" }).length,
        retrying: this.sessionManager.list({ status: "retrying" }).length,
      },
      queue: {
        pending: this.runtimeKernel?.getPendingDepth() ?? 0,
      },
    };
  }

  private keepAlive() {
    // Keep the event loop busy
    const interval = setInterval(() => {
      if (!this.running) {
        clearInterval(interval);
      }
    }, 1000);
  }
}
