
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

const MAX_ATTEMPTS = 3;
const RETRY_DELAY = 10000;

sdkLogger.configure({
  isDebugEnabled: process.env.CLOUD189_VERBOSE === "1",
});

// 捕获 SDK 内部原本会被 getSession 吞掉的密码登录异常
function captureLoginError(cloudClient) {
  const authClient = cloudClient.authClient;

  const originalLogin =
    authClient.loginByPassword.bind(authClient);

  let lastLoginError = null;

  authClient.loginByPassword = async (...args) => {
    try {
      const result = await originalLogin(...args);
      lastLoginError = null;
      return result;
    } catch (error) {
      lastLoginError = error;
      throw error;
    }
  };

  return () => lastLoginError;
}

// 获取真实错误原因，以及是否应该重试
function getErrorInfo(error) {
  const message = String(
    error?.message || "未知错误"
  )
    .split(/\r?\n/)[0]
    .replace(/^(RequestError|Error):\s*/i, "")
    .trim();

  const codes = [
    error?.code,
    error?.cause?.code,
    ...(Array.isArray(error?.errors)
      ? error.errors.map((item) => item?.code)
      : []),
  ].filter(Boolean).join(" ");

  // 认证失败：不重试
  if (
    /验证码|账户名或密码错误|账号或密码错误|用户名或密码错误|设备锁|二次验证|设备验证/i
      .test(message)
  ) {
    return {
      reason: message.slice(0, 120),
      retryable: false,
    };
  }

  // 网络连接超时：允许重试
  if (
    /ETIMEDOUT|ERR_SOCKET_CLOSED_BEFORE_CONNECTION/i
      .test(`${message} ${codes}`)
  ) {
    return {
      reason: "网络连接超时",
      retryable: true,
    };
  }

  // 网络异常：允许重试
  if (
    /ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENETUNREACH/i
      .test(`${message} ${codes}`)
  ) {
    return {
      reason: "网络连接异常",
      retryable: true,
    };
  }

  // 未知 Session 异常：不盲目重试
  if (/Can not get session/i.test(message)) {
    return {
      reason: "无法获取登录会话",
      retryable: false,
    };
  }

  return {
    reason: message.slice(0, 120),
    retryable: false,
  };
}

// 个人任务签到
const doUserTask = async (cloudClient, logger) => {
  const result = await cloudClient.userSign();

  const netdiskBonus = result.isSign
    ? 0
    : result.netdiskBonus;

  logger.info(
    `个人签到任务: 获得 ${netdiskBonus}M 空间`
  );
};

// 单个账号执行逻辑
const run = async (
  userName,
  password,
  userSizeInfoMap,
  logger
) => {
  if (!userName || !password) {
    return false;
  }

  const before = Date.now();
  const maskedUser = mask(userName, 3, 7);

  logger.log("开始执行");

  try {
    for (
      let attempt = 1;
      attempt <= MAX_ATTEMPTS;
      attempt++
    ) {
      // 每次执行使用独立的异常捕获器
      let getLastLoginError = () => null;

      try {
        const cloudClient = new CloudClient({
          username: userName,
          password,
          token: new FileTokenStore(
            `${tokenDir}/${userName}.json`
          ),
        });

        // 记录密码登录时的原始异常
        getLastLoginError = captureLoginError(
          cloudClient
        );

        const beforeUserSizeInfo =
          await cloudClient.getUserSizeInfo();

        await doUserTask(cloudClient, logger);

        // 成功后保存容量统计信息
        userSizeInfoMap.set(userName, {
          cloudClient,
          userSizeInfo: beforeUserSizeInfo,
          logger,
        });

        return true;

      } catch (error) {
        // 优先采用实际密码登录时的异常
        const actualError =
          getLastLoginError() || error;

        const { reason, retryable } =
          getErrorInfo(actualError);

        // Actions 控制台输出简短诊断
        console.error(
          `[${maskedUser}] 第 ${attempt} 次失败: ${reason}`
        );

        if (
          retryable &&
          attempt < MAX_ATTEMPTS
        ) {
          console.warn(
            `[${maskedUser}] ${RETRY_DELAY / 1000} 秒后重试 (${attempt}/${MAX_ATTEMPTS})`
          );

          await delay(RETRY_DELAY);
          continue;
        }

        const retryInfo = retryable
          ? `（已尝试 ${attempt} 次）`
          : "";

        // 推送仅包含简短错误原因
        logger.error(
          `签到失败：${reason}${retryInfo}`
        );

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

  return false;
};

// 主程序
async function main() {
  const userSizeInfoMap = new Map();

  // 逐个执行账号
  for (const account of accounts) {
    const { userName, password } = account;

    const maskedUser = mask(userName, 3, 7);
    const logger = log4js.getLogger(userName);

    logger.addContext("user", maskedUser);

    await run(
      userName,
      password,
      userSizeInfoMap,
      logger
    );
  }

  // 查询签到后的容量变化
  for (const [
    userName,
    { cloudClient, userSizeInfo, logger },
  ] of userSizeInfoMap) {
    try {
      const afterUserSizeInfo =
        await cloudClient.getUserSizeInfo();

      const cloudBefore =
        userSizeInfo.cloudCapacityInfo.totalSize;

      const cloudAfter =
        afterUserSizeInfo.cloudCapacityInfo.totalSize;

      const familyBefore =
        userSizeInfo.familyCapacityInfo.totalSize;

      const familyAfter =
        afterUserSizeInfo.familyCapacityInfo.totalSize;

      const MB = 1024 * 1024;
      const GB = MB * 1024;

      logger.log(
        `个人容量：⬆️  ${(
          (cloudAfter - cloudBefore) / MB
        ).toFixed(2)}M/${(
          cloudAfter / GB
        ).toFixed(2)}G`,

        `家庭容量：⬆️  ${(
          (familyAfter - familyBefore) / MB
        ).toFixed(2)}M/${(
          familyAfter / GB
        ).toFixed(2)}G`
      );

    } catch (error) {
      console.error(
        `[${mask(userName, 3, 7)}] 容量查询失败:`,
        error
      );

      logger.error("容量查询失败");
    }
  }
}

// 程序入口
(async () => {
  try {
    await main();
    await delay(1000);

  } finally {
    // 只推送业务日志，不推送 SDK 堆栈
    const logs = catLogs();

    push("天翼云盘自动签到任务", logs);

    recording.erase();
    cleanLogs();
  }
})();
