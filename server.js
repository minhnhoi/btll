// server.js

require("dotenv").config();
const express = require("express");
const multer = require("multer");
const cloudinary = require("cloudinary").v2;
const cors = require("cors");
const streamifier = require("streamifier");
const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");

const app = express();
const port = process.env.PORT || 3000;

app.use(express.static(__dirname));

app.get("/", (req, res) => {
  res.sendFile(__dirname + "/index.html");
});

app.use(cors());
app.use(express.json({ limit: "50mb" }));


// =======================
// MongoDB Access Logging
// =======================
// NOTE: Trình duyệt web không cho lấy "tên máy tính/hostname" thật.
// Nếu cần "deviceName" thì user tự nhập hoặc bạn tự đặt trên UI.

app.set("trust proxy", true); // để lấy IP thật khi chạy sau proxy/nginx

async function connectMongo() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.warn("⚠️ MONGODB_URI chưa cấu hình -> bỏ qua Mongo logging.");
    return;
  }
  try {
    await mongoose.connect(uri, {
      autoIndex: true,
      serverSelectionTimeoutMS: 8000,
    });
    console.log("✅ MongoDB connected");
  } catch (e) {
    console.error("❌ MongoDB connect error:", e.message);
  }
}

const AccessLogSchema = new mongoose.Schema(
  {
    ts: { type: Date, default: Date.now, index: true },

    // Server-collected
    ip: { type: String, index: true },
    method: String,
    path: String,
    status: Number,
    durationMs: Number,

    userAgent: String,
    referer: String,
    acceptLanguage: String,

    // Optional: client-sent (không nhạy cảm)
    client: {
      timezone: String,
      platform: String,
      language: String,
      screen: { w: Number, h: Number },
      deviceMemory: Number,
      hardwareConcurrency: Number,
      touch: Boolean,
      // user-provided only (không phải hostname thật)
      deviceName: String,
    },
  },
  { versionKey: false }
);

const AccessLog =
  mongoose.models.AccessLog || mongoose.model("AccessLog", AccessLogSchema);

// Log mọi request (audit nhẹ). Không log body/query để tránh nhạy cảm.
app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", async () => {
    try {
      if (mongoose.connection?.readyState !== 1) return;

      const xff = req.headers["x-forwarded-for"];
      const ip =
        (typeof xff === "string" && xff.split(",")[0].trim()) ||
        req.ip ||
        req.socket?.remoteAddress;

      await AccessLog.create({
        ip,
        method: req.method,
        path: req.originalUrl || req.url,
        status: res.statusCode,
        durationMs: Date.now() - start,
        userAgent: req.headers["user-agent"],
        referer: req.headers["referer"],
        acceptLanguage: req.headers["accept-language"],
      });
    } catch (e) {
      // không làm sập request vì log
      console.warn("log error:", e.message);
    }
  });
  next();
});

// Client gửi thêm thông tin thiết bị (optional)
app.post("/telemetry/client", async (req, res) => {
  try {
    if (mongoose.connection?.readyState !== 1) {
      return res.json({ success: false, message: "Mongo chưa sẵn sàng" });
    }

    const body = req.body || {};
    const xff = req.headers["x-forwarded-for"];
    const ip =
      (typeof xff === "string" && xff.split(",")[0].trim()) ||
      req.ip ||
      req.socket?.remoteAddress;

    await AccessLog.create({
      ip,
      method: "CLIENT",
      path: "telemetry",
      status: 200,
      durationMs: 0,
      userAgent: req.headers["user-agent"],
      referer: req.headers["referer"],
      acceptLanguage: req.headers["accept-language"],
      client: {
        timezone: body.timezone,
        platform: body.platform,
        language: body.language,
        screen: body.screen,
        deviceMemory: body.deviceMemory,
        hardwareConcurrency: body.hardwareConcurrency,
        touch: body.touch,
        deviceName: body.deviceName,
      },
    });

    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "123456";
const MAX_FILES_LIMIT = 50;

const FACE_DB_PATH = path.join(__dirname, "face_db.json");
const FACE_DB_CLOUD_ID = "system_face_id_backup.json";

const accounts = [
  {
    name: "Kho Chính (Cloudinary main)",
    cloud_name: process.env.CLOUD_NAME_1,
    api_key: process.env.CLOUD_API_KEY_1,
    api_secret: process.env.CLOUD_API_SECRET_1,
  },
  {
    name: "Kho Dự Phòng 1 (Cloudinary 1)",
    cloud_name: process.env.CLOUD_NAME_2,
    api_key: process.env.CLOUD_API_KEY_2,
    api_secret: process.env.CLOUD_API_SECRET_2,
  },
  {
    name: "Kho Dự Phòng 2 (Cloudinary 2)",
    cloud_name: process.env.CLOUD_NAME_3,
    api_key: process.env.CLOUD_API_KEY_3,
    api_secret: process.env.CLOUD_API_SECRET_3,
  },
  {
    name: "Kho Dự Phòng 3 (Cloudinary 3)",
    cloud_name: process.env.CLOUD_NAME_4,
    api_key: process.env.CLOUD_API_KEY_4,
    api_secret: process.env.CLOUD_API_SECRET_4,
  }
];

const setCloudinaryConfig = (index) => {
  const acc = accounts[index];

  if (!acc || !acc.cloud_name || !acc.api_key || !acc.api_secret) {
    return null;
  }

  try {
    cloudinary.config({
      cloud_name: acc.cloud_name,
      api_key: acc.api_key,
      api_secret: acc.api_secret,
    });
    return acc;
  } catch (e) {
    console.error("Lỗi config Cloudinary:", e);
    return null;
  }
};

async function backupFaceDBToCloud() {
  console.log(">> [SYSTEM] Đang backup Face ID lên Cloudinary...");

  setCloudinaryConfig(0);

  if (!fs.existsSync(FACE_DB_PATH)) return;

  try {
    await cloudinary.uploader.upload(FACE_DB_PATH, {
      public_id: FACE_DB_CLOUD_ID,
      resource_type: "raw",
      overwrite: true,
      folder: "system_backup",
      invalidate: true, 
    });
    console.log(">> [SYSTEM] Backup Face ID thành công!");
  } catch (error) {
    console.error(">> [SYSTEM] Lỗi backup Face ID:", error.message);
  }
}

async function restoreFaceDBFromCloud() {
  console.log(">> [SYSTEM] 🚀 Đang khôi phục Face ID từ Cloudinary...");
  setCloudinaryConfig(0);

  try {
  
    const url = cloudinary.url("system_backup/" + FACE_DB_CLOUD_ID, {
      resource_type: "raw",
    });

 
    const fetchUrl = `${url}?t=${new Date().getTime()}`;
    const response = await fetch(fetchUrl, { cache: "no-store" });

    if (!response.ok) throw new Error("File backup chưa tồn tại hoặc lỗi mạng");

    const data = await response.json();

    fs.writeFileSync(FACE_DB_PATH, JSON.stringify(data, null, 2));
    console.log(">> [SYSTEM] 👌 Khôi phục dữ liệu Face ID thành công!");
  } catch (error) {
    console.log(
      ">> [SYSTEM] ⚠️ Chưa có bản backup hoặc lỗi (" +
        error.message +
        "). ❌ Tạo Database rỗng."
    );

    if (!fs.existsSync(FACE_DB_PATH)) {
      fs.writeFileSync(FACE_DB_PATH, "[]");
    }
  }
}

app.get("/face-id/load", (req, res) => {
  if (!fs.existsSync(FACE_DB_PATH)) {
    return res.json({ success: true, data: [] });
  }
  try {
    const raw = fs.readFileSync(FACE_DB_PATH);
    const data = JSON.parse(raw);
    res.json({ success: true, data: data });
  } catch (e) {
    console.error("Lỗi đọc DB:", e);
    
    res.json({ success: true, data: [] });
  }
});

app.post("/face-id/register", async (req, res) => {
  try {
    const { label, descriptors } = req.body;

    let users = [];
    if (fs.existsSync(FACE_DB_PATH)) {
      try {
        users = JSON.parse(fs.readFileSync(FACE_DB_PATH));
      } catch (e) {}
    }

    users = users.filter((u) => u.label !== "Admin");
    users.push({ label, descriptors });

    fs.writeFileSync(FACE_DB_PATH, JSON.stringify(users, null, 2));

  
    backupFaceDBToCloud();

    res.json({ success: true, message: "Đã lưu và đang đồng bộ lên Cloud!" });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: "Lỗi Server lưu Face ID" });
  }
});

app.delete("/face-id/clear", (req, res) => {
  try {
    fs.writeFileSync(FACE_DB_PATH, "[]");
    backupFaceDBToCloud();
    res.json({ success: true, message: "Đã xóa toàn bộ dữ liệu Face ID" });
  } catch (e) {
    res.status(500).json({ success: false, message: "Lỗi khi xóa dữ liệu" });
  }
});

app.get("/stats", async (req, res) => {
  const index = req.query.index || 0;
  const acc = setCloudinaryConfig(index);

  if (!acc) {
    return res.json({
      success: true,
      isEmpty: true,
      totalFiles: 0,
      storage: { used: 0, total: 0, percent: 0 },
    });
  }

  try {
    let totalFiles = 0;

    try {
      const checkResult = await cloudinary.search
        .expression(
          "resource_type:image OR resource_type:video OR resource_type:raw"
        )
        .max_results(1)
        .execute();
      totalFiles = checkResult.total_count;
    } catch (err) {
      console.log(`Cổng ${index} sai mật khẩu hoặc lỗi mạng:`, err.message);
      return res.json({
        success: true,
        isAuthError: true,
        totalFiles: 0,
        storage: { used: 0, total: 0, percent: 0 },
      });
    }

    let usageData = { used: 0, total: 25, percent: 0 };
    try {
      const usageResult = await cloudinary.api.usage();
      const usedCredits = usageResult.credits?.usage || 0;
      const limitCredits = usageResult.plan_limits?.credits || 25;
      usageData = {
        used: usedCredits.toFixed(2),
        total: limitCredits,
        percent: Math.min(100, Math.round((usedCredits / limitCredits) * 100)),
      };
    } catch (e) {}

  
    res.json({
      success: true,
      totalFiles: totalFiles,
      storage: usageData,
      files: {
        remaining: Math.max(0, MAX_FILES_LIMIT - totalFiles),
        limit: MAX_FILES_LIMIT,
      },
    });
  } catch (error) {
    res.json({ success: false, message: "Lỗi server nội bộ" });
  }
});

const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

app.get("/accounts", (req, res) => {
  const list = accounts
    .map((acc, index) => (acc.cloud_name ? { index, name: acc.name } : null))
    .filter((item) => item !== null);
  res.json({ success: true, accounts: list });
});

app.post("/upload", upload.single("myFile"), async (req, res) => {
  if (!req.file)
    return res.status(400).json({ success: false, message: "Chưa chọn file!" });

  const index = req.body.accountIndex || 0;
  const acc = setCloudinaryConfig(index);
  if (!acc)
    return res
      .status(500)
      .json({ success: false, message: "Lỗi cấu hình server." });

  const uploadStream = cloudinary.uploader.upload_stream(
    {
      folder: "upload_master",
      resource_type: "auto",
    },
    (error, result) => {
      if (error)
        return res.status(500).json({ success: false, message: error.message });
      res.json({
        success: true,
        data: {
          public_id: result.public_id,
          asset_id: result.asset_id,
          cloud_name: acc.cloud_name,
          filename: result.original_filename,
          secure_url: result.secure_url,
          resource_type: result.resource_type,
          format: result.format,
          bytes: result.bytes,
          created_at: result.created_at,
        },
      });
    }
  );
  streamifier.createReadStream(req.file.buffer).pipe(uploadStream);
});

app.post("/upload-url", async (req, res) => {
  const { url, accountIndex } = req.body;
  if (!url) return res.json({ success: false, message: "Thiếu URL" });

  const acc = setCloudinaryConfig(accountIndex || 0);
  if (!acc) return res.json({ success: false, message: "Lỗi cấu hình Cloud" });

  try {
    const result = await cloudinary.uploader.upload(url, {
      folder: "upload_master_url",
      resource_type: "auto",
    });

    res.json({
      success: true,
      data: {
        public_id: result.public_id,
        asset_id: result.asset_id,
        cloud_name: acc.cloud_name,
        filename: result.original_filename || "url_upload",
        secure_url: result.secure_url,
        resource_type: result.resource_type,
        format: result.format,
        bytes: result.bytes,
        created_at: result.created_at,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: "Lỗi: " + error.message });
  }
});

async function getFilesHandler(req, res, indexParam) {
  const index = indexParam || req.query.index || 0;
  const acc = setCloudinaryConfig(index);

  if (!acc) {
    return res.json({
      success: true,
      files: [],
      message: "Cổng này chưa được kết nối hoặc cấu hình sai.",
    });
  }

  try {
    const result = await cloudinary.search
      .expression(
        "resource_type:image OR resource_type:video OR resource_type:raw"
      )
      .sort_by("created_at", "desc")
      .max_results(500)
      .execute();

    res.json({ success: true, files: result.resources });
  } catch (e) {
    console.error(`Lỗi lấy danh sách file (Cổng ${index}):`, e.message);
    res.json({ success: false, message: e.message, files: [] });
  }
}

app.get("/files", (req, res) => getFilesHandler(req, res));

app.get("/admin/files/:index", (req, res) => {
  const token = req.headers["x-admin-pass"];
  if (token !== ADMIN_PASSWORD)
    return res.json({ success: false, message: "Sai mật khẩu Admin" });

  return getFilesHandler(req, res, req.params.index);
});

app.post("/admin/login", (req, res) => {
  const { password } = req.body;
  res.json({ success: password === ADMIN_PASSWORD });
});

app.delete("/admin/files/:index/:id", async (req, res) => {
  const token = req.headers["x-admin-pass"];
  if (token !== ADMIN_PASSWORD)
    return res.status(403).json({ success: false, message: "Forbidden" });

  const { index, id } = req.params;
  setCloudinaryConfig(index);

  try {
    const publicId = decodeURIComponent(id);
    let result = await cloudinary.uploader.destroy(publicId);

    if (result.result !== "ok") {
      result = await cloudinary.uploader.destroy(publicId, {
        resource_type: "video",
      });
    }
    if (result.result !== "ok") {
      result = await cloudinary.uploader.destroy(publicId, {
        resource_type: "raw",
      });
    }

    if (result.result === "ok" || result.result === "not found") {
      res.json({ success: true });
    } else {
      res.json({ success: false, message: result.result });
    }
  } catch (e) {
    res.json({ success: false, message: e.message });
  }
});

app.post("/admin/rename", async (req, res) => {
  const token = req.headers["x-admin-pass"];
  if (token !== ADMIN_PASSWORD)
    return res.status(403).json({ success: false, message: "Forbidden" });

  const { accountIndex, fileId, newName } = req.body;
  setCloudinaryConfig(accountIndex);

  try {
    const result = await cloudinary.uploader.rename(fileId, newName);
    res.json({ success: true, data: result });
  } catch (e) {
    res.json({ success: false, message: e.message });
  }
});

app.post("/admin/delete-batch", async (req, res) => {
  const token = req.headers["x-admin-pass"];
  if (token !== ADMIN_PASSWORD)
    return res.json({ success: false, message: "Forbidden" });

  const { accountIndex, files } = req.body;
  setCloudinaryConfig(accountIndex);

  if (!files || !Array.isArray(files) || files.length === 0) {
    return res.json({ success: false, message: "Chưa chọn file nào." });
  }

  try {
    let deletedCount = 0;
    const deletePromises = files.map(async (file) => {
      try {
        const type = file.type || "image";
        await cloudinary.uploader.destroy(file.id, { resource_type: type });
        deletedCount++;
      } catch (err) {
        console.error(`Lỗi xóa file ${file.id}:`, err.message);
      }
    });

    await Promise.all(deletePromises);
    res.json({ success: true, count: deletedCount });
  } catch (e) {
    res.json({ success: false, message: e.message });
  }
});

app.get("/admin/stats-all", async (req, res) => {
  const token = req.headers["x-admin-pass"];
  if (token !== ADMIN_PASSWORD)
    return res.json({ success: false, message: "Forbidden" });

  try {
    const results = [];

    for (let i = 0; i < accounts.length; i++) {
      const acc = accounts[i];

      if (!acc.cloud_name) {
        results.push({
          index: i,
          name: acc.name || `Server ${i + 1}`,
          percent: 0,
          usedGB: 0,
          totalGB: 0,
          status: "empty",
        });
        continue;
      }

      try {
        cloudinary.config({
          cloud_name: acc.cloud_name,
          api_key: acc.api_key,
          api_secret: acc.api_secret,
        });

        const checkCount = await cloudinary.search
          .expression(
            "resource_type:image OR resource_type:video OR resource_type:raw"
          )
          .max_results(1)
          .execute();

        const realTotalFiles = checkCount.total_count;
        const usageResult = await cloudinary.api.usage();
        let rawUsed = usageResult.credits?.usage || 0;
        const total = usageResult.plan_limits?.credits || 25;

        if (realTotalFiles === 0) {
          rawUsed = 0;
        }

        let used = Math.max(0, rawUsed);
        let finalPercent = parseFloat(((used / total) * 100).toFixed(2));

        results.push({
          index: i,
          name: acc.name,
          usedGB: used.toFixed(2),
          totalGB: total,
          percent: finalPercent,
          status: "online",
        });
      } catch (err) {
        console.error(`Lỗi check stats server ${i}:`, err.message);
        results.push({
          index: i,
          name: acc.name,
          percent: 0,
          usedGB: 0,
          totalGB: 0,
          status: "error",
          message: "Lỗi kết nối",
        });
      }
    }

    res.json({ success: true, servers: results });
  } catch (e) {
    res.json({ success: false, message: e.message });
  }
});

app.post("/admin/empty-trash/:index", (req, res) => {
  res.json({ success: true, message: "Cloudinary tự động quản lý thùng rác." });
});

app.listen(port, async () => {
  console.log(`✅ Server Cloudinary đang chạy tại http://localhost:${port}`);
  await connectMongo();
  await restoreFaceDBFromCloud();
});