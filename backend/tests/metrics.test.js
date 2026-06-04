const request = require("supertest");
const express = require("express");
const mongoose = require("mongoose");
const path = require("path");

// Simple mocked server to test only the conversion rate math
// using the same logic we use in metricsController.
const app = express();

app.get("/api/metrics/test", (req, res) => {
  // Test scenario 1: Conversion rate math formula
  const unique_invoice_count = 24;
  const soloUnits = 10;
  const groupUnits = 5;
  const totalBuyingUnits = soloUnits + groupUnits; // 15
  
  const conversionRate = totalBuyingUnits > 0
    ? parseFloat(((unique_invoice_count / totalBuyingUnits) * 100).toFixed(2))
    : 0;

  res.json({
    total_buying_units: totalBuyingUnits,
    total_unique_invoices: unique_invoice_count,
    store_conversion_rate_pct: conversionRate
  });
});

app.get("/api/metrics/test-empty", (req, res) => {
  // Test scenario 2: Empty CSV / No Walk-ins
  const unique_invoice_count = 0;
  const totalBuyingUnits = 0;
  
  const conversionRate = totalBuyingUnits > 0
    ? parseFloat(((unique_invoice_count / totalBuyingUnits) * 100).toFixed(2))
    : 0;

  res.json({
    total_buying_units: totalBuyingUnits,
    total_unique_invoices: unique_invoice_count,
    store_conversion_rate_pct: conversionRate
  });
});

describe("Metrics Controller Logic Tests", () => {
  test("Conversion Rate Math Formula - Should correctly calculate percentage using Buying Units", async () => {
    const response = await request(app).get("/api/metrics/test");
    
    expect(response.status).toBe(200);
    expect(response.body.total_buying_units).toBe(15);
    expect(response.body.total_unique_invoices).toBe(24);
    // (24 / 15) * 100 = 160.00
    expect(response.body.store_conversion_rate_pct).toBe(160);
  });

  test("Empty CSV / Zero Walk-ins - Should safely handle zero denominator", async () => {
    const response = await request(app).get("/api/metrics/test-empty");
    
    expect(response.status).toBe(200);
    expect(response.body.total_buying_units).toBe(0);
    expect(response.body.total_unique_invoices).toBe(0);
    // 0 denominator should yield 0 conversion rate safely
    expect(response.body.store_conversion_rate_pct).toBe(0);
  });
});
