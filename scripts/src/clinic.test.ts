import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");
const indexSource = readFileSync(resolve(root, "index.html"), "utf8");
const offlineSource = readFileSync(resolve(root, "offline-manager.js"), "utf8");
const rulesSource = readFileSync(resolve(root, "firestore.rules"), "utf8");
const indexes = JSON.parse(readFileSync(resolve(root, "firestore.indexes.json"), "utf8")) as {
  indexes: Array<{ collectionGroup: string; fields: Array<{ fieldPath: string }> }>;
};

describe("Task 11 Step 1 clinic foundation contracts", () => {
  it("declares the clinic institution metadata and seeded service workflow", () => {
    for (const value of [
      "clinicLicenseNumber",
      "facilityType",
      "servicesOffered",
      "operatingHours",
      "emergencyContact",
      "beds",
      "clinic_branches",
      "clinic_services",
      "General Consultation",
      "Maternal &amp; Child Health",
      "Pharmacy",
    ]) {
      expect(indexSource).toContain(value);
    }
    expect(indexSource).toContain("values.type==='clinic'?'clinic_admin'");
    expect(rulesSource).toContain("sameClinicInstitution");
  });

  it("provides all six clinic roles and role-specific navigation", () => {
    for (const role of ["clinic_admin", "doctor", "nurse", "receptionist", "pharmacist", "patient"]) {
      expect(indexSource).toContain(role);
    }
    expect(indexSource).toContain("function isClinicRole");
    expect(indexSource).toContain("setupClinicNavigation");
    expect(indexSource).toContain("clinicPatientPortalPage");
    expect(indexSource).toContain("clinicWorkPage");
  });

  it("implements patient registration, appointments, duplicate prevention, and check-in", () => {
    for (const value of [
      "clinic_patients",
      "clinicPatientForm",
      "createManagedAuthUser(email,password)",
      "clinic_appointments",
      "That doctor already has an appointment at this time.",
      "queueClinicCheckin",
      "Patient checked in",
    ]) {
      expect(indexSource + offlineSource).toContain(value);
    }
  });

  it("implements nurse vitals, BMI, abnormal indicators, doctor visits, and prescriptions", () => {
    for (const value of [
      "clinicVitalTemperature",
      "clinicVitalPulse",
      "clinicVitalRespiratory",
      "clinicUpdateBmi",
      "clinic-abnormal",
      "clinic_visits",
      "clinic_prescriptions",
      "queueClinicVisit",
      "queueClinicPrescription",
      "Prescription ready",
    ]) {
      expect(indexSource + offlineSource).toContain(value);
    }
    expect(indexSource).toContain("Mark dispensed");
  });

  it("keeps patient history read-only and receptionist access out of medical collections", () => {
    expect(indexSource).toContain("Read-only access to your visits and prescriptions.");
    expect(rulesSource).toContain("match /clinic_visits/{visitId}");
    expect(rulesSource).toContain("match /clinic_prescriptions/{prescriptionId}");
    expect(rulesSource).toContain("role() in ['clinic_admin', 'receptionist']");
    expect(rulesSource).toContain("role() in ['clinic_admin', 'doctor', 'nurse']");
    expect(rulesSource).toContain("role() in ['clinic_admin', 'doctor', 'pharmacist']");
  });

  it("declares all required clinic composite indexes", () => {
    const required: Array<[string, string[]]> = [
      ["clinic_patients", ["institutionId", "createdAt"]],
      ["clinic_patients", ["institutionId", "phone"]],
      ["clinic_appointments", ["institutionId", "appointmentDate", "appointmentTime"]],
      ["clinic_appointments", ["doctorId", "appointmentDate"]],
      ["clinic_visits", ["patientId", "visitDate"]],
      ["clinic_visits", ["doctorId", "visitDate"]],
      ["clinic_prescriptions", ["patientId", "createdAt"]],
      ["clinic_prescriptions", ["status", "createdAt"]],
      ["clinic_services", ["institutionId", "category"]],
    ];
    for (const [collectionGroup, fields] of required) {
      expect(indexes.indexes.some(index =>
        index.collectionGroup === collectionGroup &&
        fields.every(field => index.fields.some(item => item.fieldPath === field))
      )).toBe(true);
    }
  });

  it("keeps clinic offline stores in the IndexedDB sync contract", () => {
    for (const value of [
       "var DB_VERSION = 24",
      "offline_clinic_visits",
      "offline_clinic_prescriptions",
      "offline_clinic_checkins",
      "pushClinicVisits",
      "pushClinicPrescriptions",
      "pushClinicCheckins",
      "markClinicVisitSynced",
      "markClinicPrescriptionSynced",
      "markClinicCheckinSynced",
    ]) {
      expect(indexSource + offlineSource).toContain(value);
    }
  });
});

describe("Task 11 Step 3 clinic dashboard, reports, and administration contracts", () => {
  it("adds admin dashboard metrics, report categories, exports, and analytics", () => {
    for (const value of [
      "clinicAdminDashboardSection",
      "clinicAdminRevenueToday",
      "clinicAdminRevenueMonth",
      "clinicAdminLowStock",
      "clinicTopServices",
      "clinicAdminAlerts",
      "clinicReportsModal",
      "Financial",
      "Operational",
      "Medical",
      "Compliance",
      "Custom report",
      "Export PDF",
      "Export Excel",
      "Export CSV",
      "clinicAnalyticsModal",
      "clinicRevenueTrendChart",
      "clinicPeakHoursHeatmap",
      "clinicDoctorPerformanceTable",
      "clinicDestroyAnalyticsCharts",
      "generateClinicReport",
    ]) {
      expect(indexSource).toContain(value);
    }
  });

  it("adds institution-scoped staff, settings, communications, and branch-aware foundations", () => {
    for (const value of [
      "clinicStaffModal",
      "clinicStaffRoleFilter",
      "clinicStaffStatus",
      "clinicSettingsModal",
      "operatingHours",
      "insuranceProviders",
      "clinicCommunicationModal",
      "clinic_communications",
      "clinic_report_templates",
      "clinic_access_audit",
      "clinic_branches",
      "sameClinicAdminInstitution",
    ]) {
      expect(indexSource + rulesSource).toContain(value);
    }
    expect(rulesSource).toContain("request.resource.data.diff(resource.data).affectedKeys().hasOnly");
  });

  it("adds requested Step 3 date indexes and cached dashboard migration", () => {
    const required: Array<[string, string[]]> = [
      ["clinic_appointments", ["institutionId", "appointmentDate"]],
      ["clinic_visits", ["institutionId", "visitDate"]],
      ["clinic_prescriptions", ["institutionId", "createdAt"]],
      ["clinic_billing", ["institutionId", "billDate", "status"]],
      ["clinic_payments", ["institutionId", "paymentDate"]],
      ["clinic_pharmacy_inventory", ["institutionId", "category"]],
    ];
    for (const [collectionGroup, fields] of required) {
      expect(indexes.indexes.some(index =>
        index.collectionGroup === collectionGroup &&
        fields.every(field => index.fields.some(item => item.fieldPath === field))
      )).toBe(true);
    }
    for (const value of [
      "var DB_VERSION = 24",
      "offline_clinic_dashboard",
      "if (oldVersion < 18 &&",
      "cacheClinicDashboard",
      "getClinicDashboard",
    ]) {
      expect(offlineSource).toContain(value);
    }
  });

  it("keeps fresh reports online-only and supports offline dashboard snapshots", () => {
    expect(indexSource).toContain("Reports require internet for fresh data.");
    expect(indexSource).toContain("Offline mode: showing dashboard data");
    expect(indexSource).toContain("clinicStep3LoadData");
    expect(indexSource).toContain("Offline?.getClinicDashboard");
  });
});

describe("Task 11 Step 2 pharmacy, billing, and insurance contracts", () => {
  it("declares all five Step 2 Firestore collections and eight composite indexes", () => {
    for (const collection of [
      "clinic_pharmacy_inventory",
      "clinic_product_scans",
      "clinic_billing",
      "clinic_payments",
      "clinic_insurance_claims",
    ]) {
      expect(indexSource).toContain(collection);
      expect(rulesSource).toContain(`match /${collection}/`);
    }
    const required: Array<[string, string[]]> = [
      ["clinic_pharmacy_inventory", ["institutionId", "category"]],
      ["clinic_pharmacy_inventory", ["institutionId", "quantityInStock"]],
      ["clinic_pharmacy_inventory", ["institutionId", "expiryDate"]],
      ["clinic_billing", ["institutionId", "status", "billDate"]],
      ["clinic_billing", ["patientId", "billDate"]],
      ["clinic_payments", ["institutionId", "paymentDate"]],
      ["clinic_insurance_claims", ["institutionId", "status"]],
      ["clinic_product_scans", ["institutionId", "scannedAt"]],
    ];
    for (const [collectionGroup, fields] of required) {
      expect(indexes.indexes.some(index =>
        index.collectionGroup === collectionGroup &&
        fields.every(field => index.fields.some(item => item.fieldPath === field))
      )).toBe(true);
    }
  });

  it("provides pharmacist dashboard, inventory lifecycle, local scanner matching, and checkout", () => {
    for (const value of [
      "clinicPharmacyPage",
      "pharmacyPendingPrescriptions",
      "inventoryModal",
      "inventoryItemFormModal",
      "clinicOpenInventoryForm",
      "clinicAdjustInventory",
      "clinicDiscontinueInventory",
      "histogramEmbedding",
      "clinicProductEmbedding",
      "productScannerModal",
      "scannerCaptureBtn",
      "scannerUploadInput",
      "scannerManualBtn",
      "clinicFindProductMatches",
      "clinicCheckoutCart",
      "clinic_pharmacy_inventory",
    ]) {
      expect(indexSource).toContain(value);
    }
    expect(indexSource).toContain("Stock cannot become negative");
    expect(indexSource).toContain("Inventory with sales history is retained, not deleted.");
  });

  it("provides billing tabs, immutable paid-bill protection, payments, and invoice actions", () => {
    for (const value of [
      "clinicBillingPage",
      "Unpaid",
      "Recent payments",
      "All bills",
      "Create bill",
      "Insurance claims",
      "Daily reconciliation",
      "clinicCreateBill",
      "openBillDetail",
      "openRecordPayment",
      "clinicSavePayment",
      "Print invoice",
      "partial",
      "paid",
    ]) {
      expect(indexSource).toContain(value);
    }
    expect(rulesSource).toContain("resource.data.status != 'paid' || request.resource.data.status == 'reversed'");
  });

  it("provides insurance claims and patient billing views", () => {
    for (const value of [
      "insuranceClaimModal",
      "Draft",
      "Submitted",
      "Under Review",
      "Approved",
      "Partially Approved",
      "Rejected",
      "Paid",
      "openInsuranceClaim",
      "clinicSaveClaim",
      "clinicPatientBillingPage",
      "loadPatientBilling",
    ]) {
      expect(indexSource).toContain(value);
    }
  });

  it("extends IndexedDB migration, offline queues, and sync hooks for every Step 2 workflow", () => {
    for (const value of [
      "if (oldVersion < 17)",
      "offline_clinic_inventory",
      "offline_clinic_product_scans",
      "offline_clinic_dispensing",
      "offline_clinic_billing",
      "offline_clinic_payments",
      "offline_clinic_claims",
      "queueClinicInventory",
      "queueClinicProductScan",
      "queueClinicDispensing",
      "queueClinicBilling",
      "queueClinicPayment",
      "queueClinicClaim",
      "pushClinicInventory",
      "pushClinicScans",
      "pushClinicDispensing",
      "pushClinicBilling",
      "pushClinicPayments",
      "pushClinicClaims",
    ]) {
      expect(indexSource + offlineSource).toContain(value);
    }
  });
});