
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

sdkLogger.configure({
  isDebugEnabled: process.env.CLOUD189_VERBOSE === "1",
});

// 提取简短错误原因
const getErrorReason = (error, logStart) => {
  const events = recording.replay().slice(logStart);

  // 获取当前账号执行期间 SDK 记录的错误
  const messages = events
    .filter((event) => {
      const level = event.level?.levelStr || String(event.level);
      return level.toUpperCase() === "ERROR";
    })
    .flatMap((event) => event.data || [])
    .map((item) => {
      const message = item?.message || String(item);

      return message
        .split(/\r?\n/)[0]
        .replace(/^(RequestError|Error):\s*/i, "")
        .trim();
    })
    .filter(Boolean);

  // 优先提取 SDK 返回的具体原因
  const detail = messages.find(
    (message) =>
      /验证码|账户|账号|密码|设备|登录|认证|超时|连接|ETIMEDOUT|ECONNRESET/i.test(
        message
      ) && !message.includes("Can not get session")
  );

  // 没有具体错误则使用原始错误信息
  const reason = detail || error?.message || "未知错误";

  return String(reason)
    .split(/\r?\n/)[0]
    .replace(/^(RequestError|Error):\s*/i, "")
    .slice(0, 120);
};

// 个人任务签到
const doUserTask = async (cloudClient, logger) => {
  const result = await cloudClient.userSign();

  const netdiskBonus = result.isSign
    ? 0
    : result.netdiskBonus;

  logger.info(`个人签到任务: 获得 ${netdiskBonus}M 空间`);
};

// 执行单个账号
const run = async (
  userName,
  password,
  userSizeInfoMap,
  logger
) => {
  if (userName && password) {
    const before = Date.now();

    // 记录当前账号执行前的 SDK 日志位置
    const logStart = recording.replay().length;

    try {
      logger.log("开始执行");

      const cloudClient = new CloudClient({
        username: userName,
        password,
        token: new FileTokenStore(
          `${tokenDir}/${userName}.json`
        ),
      });

      const beforeUserSizeInfo =
        await cloudClient.getUserSizeInfo();

      userSizeInfoMap.set(userName, {
        cloudClient,
        userSizeInfo: beforeUserSizeInfo,
        logger,
      });

      await Promise.all([
        doUserTask(cloudClient, logger),
      ]);

    } catch (e) {
      // 提取简短错误原因用于通知
      const reason = getErrorReason(e, logStart);

      logger.error(`签到失败：${reason}`);

      // GitHub Actions 控制台保留完整错误
      console.error(e);

      // 网络异常继续抛出，交给 Workflow 重试
      if (
        e.code === "ECONNRESET" ||
        e.code === "ETIMEDOUT"
      ) {
        logger.error("请求超时");
        throw e;
      }

    } finally {
      logger.log(
        `执行完毕, 耗时 ${(
          (Date.now() - before) /
          1000
        ).toFixed(2)} 秒`
      );
    }
  }
};

// 开始执行程序
async function main() {
  // 用于统计实际容量变化
  const userSizeInfoMap = new Map();

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

  // 数据汇总
  for (const [
    userName,
    { cloudClient, userSizeInfo, logger },
  ] of userSizeInfoMap) {
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
  }
}

// 程序入口
(async () => {
  try {
    await main();

    // 等待日志文件写入
    await delay(1000);

  } finally {
    // 仅推送业务日志，不包含 SDK 完整异常堆栈
    const logs = catLogs();

    push("天翼云盘自动签到任务", logs);

    // 清理日志
    recording.erase();
    cleanLogs();
  }
})();
