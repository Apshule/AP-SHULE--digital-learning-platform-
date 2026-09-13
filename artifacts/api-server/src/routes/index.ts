import { Router, type IRouter } from "express";
import healthRouter from "./health";
import pushEventsRouter from "./push-events";
import pushSubscriptionsRouter from "./push-subscriptions";
import notificationsRouter from "./notifications";
import schoolRouter from "./school";
import complianceRouter from "./compliance";

const router: IRouter = Router();

router.use(healthRouter);
router.use(pushEventsRouter);
router.use(pushSubscriptionsRouter);
router.use(notificationsRouter);
router.use(schoolRouter);
router.use(complianceRouter);

export default router;
