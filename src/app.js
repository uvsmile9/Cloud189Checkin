
require("dotenv").config();

const {
  CloudClient,
  FileTokenStore,
  logger: sdkLogger,
} = require("cloud189-sdk");

const recording = require("log4js/lib/appenders/recording");
const accounts = require("../accounts");
const { mask, delay } = require("./utils");
const push = require("./push");
const { log4js, cleanLogs, catLogs } = require("./logger");

const tokenDir = ".token";

// 每个账号最多执行 3 次（首次 + 2 次重试）
const MAX_ATTEMPTS = 3;
const RETRY_DELAY = 10000;

sdkLogger.configure({
  isDebugEnabled: process.env.CLOUD189_VERBOSE === "1",
});

// 提取错误原因并判断是否需要重试
const getErrorInfo = (error, logStart) => {
  const sdkErrors = recording.replay()
    .slice(logStart)
    .filter((event) => {
      const level = event.level?.levelStr || String(event.level);
      return level.toUpperCase().includes("ERROR");
    })
    .flatMap((event) => event.data || [])
    .map((item) => {
      if (item instanceof Error) {
        return `${item.message}\n${item.stack || ""}`;
      }
      return String(item?.stack || item?.message || item);
    })
    .join("\n");

  const raw = [
    error?.message || "",
    error?.stack || "",
    error?.code || "",
    error?.cause?.message || "",
    error?.cause?.code || "",
    typeof error?.response?.body === "string"
      ? error.response.body
      : "",
    sdkErrors,
  ].join("\n");

  // 账号、验证码等认证错误：不重试
  const authPatterns = [
    /图形验证码错误[^\r\n]*/,
    /(?:账户名|账号)或密码错误[^\r\n]*/,
    /密码错误[^\r\n]*/,
    /账号不存在[^\r\n]*/,
    /设备锁|设备验证|二次验证/,
  ];

  for (const pattern of authPatterns) {
    const match = raw.match(pattern);

    if (match) {
      return {
        reason: match[0].slice(0, 120),
        retryable: false,
      };
    }
  }

  // 网络错误：允许重试
  const timeoutErrors =
    /ETIMEDOUT|ERR_SOCKET_CLOSED_BEFORE_CONNECTION/i;

  if (timeoutErrors.test(raw)) {
    return {
      reason: "网络连接超时",
      retryable: true,
    };
  }

  const networkErrors =
    /ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENETUNREACH/i;

  if (networkErrors.test(raw)) {
    return {
      reason: "网络连接异常",
      retryable: true,
    };
  }

  // SDK 外层可能只返回通用的 Session 错误
  if (/Can not get session/i.test(raw)) {
    return {
      reason: "无法获取登录会话",
      retryable: true,
    };
  }

  // 其他错误保留简短描述
  return {
    reason: String(error?.message || "未知错误")
      .split(/\r?\n/)[0]
      .replace(/^(RequestError|Error):\s*/i, "")
      .slice(0, 120),
    retryable: false,
  };
};

// 个人任务签到
const doUserTask = async (cloudClient, logger) => {
  const result = await cloudClient.userSign();

  const netdiskBonus = result.isSign
    ? 0
    : result.netdiskBonus;

  logger.info(`个人签到任务: 获得 ${netdiskBonus}M 空间`);
};

// 执行单个账号，支持独立重试
const run = async (
  userName,
  password,
  userSizeInfoMap,
  logger
) => {
  if (!userName || !password) {
    return;
  }

  const before = Date.now();

  logger.log("开始执行");

  try {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      // 每次尝试单独记录 SDK 日志位置
      const logStart = recording.replay().length;

      try {
        const cloudClient = new CloudClient({
          username: userName,
          password,
          token: new FileTokenStore(
            `${tokenDir}/${userName}.json`
          ),
        });

        const beforeUserSizeInfo =
          await cloudClient.getUserSizeInfo();

        await doUserTask(cloudClient, logger);

        // 签到成功后再加入容量统计
        userSizeInfoMap.set(userName, {
          cloudClient,
          userSizeInfo: beforeUserSizeInfo,
          logger,
        });

        return true;

      } catch (e) {
        const { reason, retryable } =
          getErrorInfo(e, logStart);

        // 完整异常只输出到 GitHub Actions
        console.error(
          `[${mask(userName, 3, 7)}] 第 ${attempt} 次尝试失败:`,
          e
        );

        // 可重试错误，且没有超过最大次数
        if (retryable && attempt < MAX_ATTEMPTS) {
          console.warn(
            `[${mask(userName, 3, 7)}] ${reason}，` +
            `${RETRY_DELAY / 1000} 秒后重试 ` +
            `(${attempt}/${MAX_ATTEMPTS})`
          );

          await delay(RETRY_DELAY);
          continue;
        }

        // 最终失败，只记录简短原因用于推送
        const retryInfo = retryable
          ? `（已尝试 ${attempt} 次）`
          : "";

        logger.error(`签到失败：${reason}${retryInfo}`);

        return false;
      }
    }
  } finally {
    logger.log(
      `执行完毕, 耗时 ${(
        (Date.now() - before) / 1000
      ).toFixed(2)} 秒`
    );
  }
};

// 开始执行程序
async function main() {
  const userSizeInfoMap = new Map();

  // 按顺序执行各个账号
  for (let index = 0; index < accounts.length; index++) {
    const account = accounts[index];
    const { userName, password } = account;

    const userNameInfo = mask(userName, 3, 7);
    const logger = log4js.getLogger(userName);

    logger.addContext("user", userNameInfo);

    await run(
      userName,
      password,
      userSizeInfoMap,
      logger
    );
  }

  // 容量变化统计
  for (const [
    userName,
    { cloudClient, userSizeInfo, logger },
  ] of userSizeInfoMap) {
    try {
      const afterUserSizeInfo =
        await cloudClient.getUserSizeInfo();

      logger.log(
        `个人容量：⬆️  ${(
          (
            afterUserSizeInfo.cloudCapacityInfo.totalSize -
            userSizeInfo.cloudCapacityInfo.totalSize
          ) /
          1024 /
          1024
        ).toFixed(2)}M/${(
          afterUserSizeInfo.cloudCapacityInfo.totalSize /
          1024 /
          1024 /
          1024
        ).toFixed(2)}G`,

        `家庭容量：⬆️  ${(
          (
            afterUserSizeInfo.familyCapacityInfo.totalSize -
            userSizeInfo.familyCapacityInfo.totalSize
          ) /
          1024 /
          1024
        ).toFixed(2)}M/${(
          afterUserSizeInfo.familyCapacityInfo.totalSize /
          1024 /
          1024 /
          1024
        ).toFixed(2)}G`
      );
    } catch (e) {
      // 容量查询失败不影响其他账号
      console.error(
        `[${mask(userName, 3, 7)}] 容量查询失败:`,
        e
      );

      logger.error("容量查询失败");
    }
  }
}

// 程序入口
(async () => {
  try {
    await main();

    // 等待日志写入
    await delay(1000);

  } finally {
    // 只推送简洁的账号日志
    const logs = catLogs();

    push("天翼云盘自动签到任务", logs);

    recording.erase();
    cleanLogs();
  }
})();
