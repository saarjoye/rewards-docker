export interface QuizData {
    // 优惠 ID
    offerId: string;
    // 测验 ID
    quizId: string;
    // 测验类别
    quizCategory: string;
    // 当前问题是否已完成
    IsCurrentQuestionCompleted: boolean;
    // 是否渲染测验总结页面
    quizRenderSummaryPage: boolean;
    // 是否重置测验
    resetQuiz: boolean;
    // 用户是否点击了提示
    userClickedOnHint: boolean;
    // 是否启用演示模式
    isDemoEnabled: boolean;
    // 正确答案
    correctAnswer: string;
    // 是否为多项选择测验类型
    isMultiChoiceQuizType: boolean;
    // 是否为排序测验类型
    isPutInOrderQuizType: boolean;
    // 是否为列表测验类型
    isListicleQuizType: boolean;
    // 是否为 WOT 测验类型
    isWOTQuizType: boolean;
    // 是否为奖励 Bug 测验类型
    isBugsForRewardsQuizType: boolean;
    // 当前问题编号
    currentQuestionNumber: number;
    // 最大问题数量
    maxQuestions: number;
    // 是否重置跟踪计数器
    resetTrackingCounters: boolean;
    // 是否显示欢迎面板
    showWelcomePanel: boolean;
    // 是否为 Ajax 调用
    isAjaxCall: boolean;
    // 是否显示提示
    showHint: boolean;
    // 选项数量
    numberOfOptions: number;
    // 是否为移动端
    isMobile: boolean;
    // 是否处于奖励模式
    inRewardsMode: boolean;
    // 是否启用每日任务集欢迎面板
    enableDailySetWelcomePane: boolean;
    // 是否启用每日任务集非欢迎面板
    enableDailySetNonWelcomePane: boolean;
    // 是否为每日任务集 URL 优惠
    isDailySetUrlOffer: boolean;
    // 是否启用每日任务集功能
    isDailySetFlightEnabled: boolean;
    // 每日任务集 URL 优惠 ID
    dailySetUrlOfferId: string;
    // 已获得的积分
    earnedCredits: number;
    // 最大可获得的积分
    maxCredits: number;
    // 每个问题的积分
    creditsPerQuestion: number;
    // 用户已经点击的选项数量
    userAlreadyClickedOptions: number;
    // 用户是否点击了选项
    hasUserClickedOnOption: boolean;
    // 最近选择的答案
    recentAnswerChoice: string;
    // 会话计时器秒数
    sessionTimerSeconds: string;
    // 覆盖层是否最小化
    isOverlayMinimized: number;
    // 移动时的屏幕阅读器消息
    ScreenReaderMsgOnMove: string;
    // 放下时的屏幕阅读器消息
    ScreenReaderMsgOnDrop: string;
    // 是否启用部分积分
    IsPartialPointsEnabled: boolean;
    // 是否优先使用 URL 而不是 Cookie
    PrioritizeUrlOverCookies: boolean;
    // 是否使用新的报告活动 API
    UseNewReportActivityAPI: boolean;
    // 正确回答的问题数量
    CorrectlyAnsweredQuestionCount: number;
    // 是否显示加入奖励页面
    showJoinRewardsPage: boolean;
    // WOT 测验的正确选项答案
    CorrectOptionAnswer_WOT: string;
    // WOT 测验的错误选项答案
    WrongOptionAnswer_WOT: string;
    // 是否启用幻灯片动画
    enableSlideAnimation: boolean;
    // 是否启用 aria 日志记录
    ariaLoggingEnabled: boolean;
    // 是否在活动 ID 中使用问题索引
    UseQuestionIndexInActivityId: boolean;
}
