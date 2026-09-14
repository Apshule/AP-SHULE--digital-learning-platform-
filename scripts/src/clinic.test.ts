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
      "var DB_VERSION = 16",
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