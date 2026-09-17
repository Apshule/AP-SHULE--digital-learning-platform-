import { Router, type IRouter } from "express";
import healthRouter from "./health";
import pushEventsRouter from "./push-events";
import pushSubscriptionsRouter from "./push-subscriptions";
import notificationsRouter from "./notifications";
import schoolRouter from "./school";
import complianceRouter from "./compliance";
import yoPaymentsRouter from "./yo-payments";
import yoPaySubscriptionsRouter from "./yopay-subscriptions";
import aiAssistantRouter from "./ai-assistant";
import youtubeRouter from "./youtube";
import studentReferralsRouter from "./student-referrals";
import skillsRouter from "./skills";

const router: IRouter = Router();

router.use(healthRouter);
router.use(pushEventsRouter);
router.use(pushSubscriptionsRouter);
router.use(notificationsRouter);
router.use(schoolRouter);
router.use(complianceRouter);
router.use(yoPaymentsRouter);
router.use(yoPaySubscriptionsRouter);
router.use(aiAssistantRouter);
router.use(youtubeRouter);
router.use(studentReferralsRouter);
router.use(skillsRouter);

export default router;
