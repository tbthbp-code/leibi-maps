import express from "express";
import multer from "multer";
import cors from "cors";
import dotenv from "dotenv";
import fetch from "node-fetch";
import FormData from "form-data";
import { createClient } from "@supabase/supabase-js";

dotenv.config();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.use(cors());
app.use(express.json());

// ---------- 已点亮正式区域 ----------

app.get("/unlocked-boundaries", async (req, res) => {
  const { data, error } = await supabase
    .from("unlocked_boundaries")
    .select("*")
    .order("unlocked_at", { ascending: true });

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  res.json(data.map(item => item.boundary_id));
});

app.post("/unlocked-boundaries", async (req, res) => {
  const { boundaryId } = req.body;

  if (!boundaryId) {
    return res.status(400).json({ error: "Missing boundaryId" });
  }

  const { data, error } = await supabase
    .from("unlocked_boundaries")
    .upsert(
      { boundary_id: boundaryId },
      { onConflict: "boundary_id" }
    )
    .select()
    .single();

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  res.json({
    boundaryId: data.boundary_id,
    unlockedAt: data.unlocked_at
  });
});

// ---------- Pending claims：未知区域临时点亮 ----------

app.get("/pending-claims", async (req, res) => {
  const { data, error } = await supabase
    .from("pending_claims")
    .select("*")
    .order("created_at", { ascending: true });

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  res.json(data);
});

app.post("/pending-claims", async (req, res) => {
  const { lng, lat, userId } = req.body;

  if (typeof lng !== "number" || typeof lat !== "number") {
    return res.status(400).json({ error: "Missing lng or lat" });
  }

  const id = `pending-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const { data, error } = await supabase
    .from("pending_claims")
    .insert({
      id,
      lng,
      lat,
      radius_m: 80,
      status: "pending",
      user_id: userId || "anonymous"
    })
    .select()
    .single();

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  res.json(data);
});

// ---------- 植物记录 ----------

app.get("/plant-records/:boundaryId", async (req, res) => {
  const { boundaryId } = req.params;

  const { data, error } = await supabase
    .from("plant_records")
    .select("*")
    .eq("boundary_id", boundaryId)
    .order("created_at", { ascending: false });

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  const records = data.map(record => ({
    id: record.id,
    userId: record.user_id,
    commonName: record.common_name,
    scientificName: record.scientific_name,
    genus: record.genus,
    family: record.family,
    score: Number(record.score || 0),
    imageUrl: record.image_url || "",
    time: new Date(record.created_at).toLocaleString()
  }));

  res.json(records);
});

app.post("/plant-records", async (req, res) => {
  const { boundaryId, plant, userId } = req.body;

  if (!boundaryId || !plant || !userId) {
    return res.status(400).json({
      error: "Missing boundaryId, plant or userId"
    });
  }

  const { data, error } = await supabase
    .from("plant_records")
    .insert({
      boundary_id: boundaryId,
      user_id: userId,
      common_name: plant.commonName,
      scientific_name: plant.scientificName,
      genus: plant.genus,
      family: plant.family,
      score: plant.score,
      image_url: plant.imageUrl || null
    })
    .select()
    .single();

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  res.json({
    id: data.id,
    userId: data.user_id,
    commonName: data.common_name,
    scientificName: data.scientific_name,
    genus: data.genus,
    family: data.family,
    score: Number(data.score || 0),
    imageUrl: data.image_url || "",
    time: new Date(data.created_at).toLocaleString()
  });
});

// 只能删除自己上传的植物
app.delete("/plant-records/:boundaryId/:recordId", async (req, res) => {
  const { boundaryId, recordId } = req.params;
  const { userId } = req.query;

  if (!userId) {
    return res.status(400).json({ error: "Missing userId" });
  }

  const { error } = await supabase
    .from("plant_records")
    .delete()
    .eq("id", recordId)
    .eq("boundary_id", boundaryId)
    .eq("user_id", userId);

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  res.json({ success: true });
});

// ---------- 植物识别 + 图片上传 ----------

async function uploadPlantPhotoToSupabase(file) {
  const fileExt = file.originalname?.split(".").pop() || "jpg";
  const fileName = `plant-${Date.now()}-${Math.random().toString(36).slice(2)}.${fileExt}`;

  const { error } = await supabase.storage
    .from("plant-photos")
    .upload(fileName, file.buffer, {
      contentType: file.mimetype,
      upsert: false
    });

  if (error) {
    console.error("Photo upload error:", error.message);
    return "";
  }

  const { data } = supabase.storage
    .from("plant-photos")
    .getPublicUrl(fileName);

  return data.publicUrl;
}

app.post("/identify-plant", upload.single("image"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No image uploaded" });
    }

    const apiKey = process.env.PLANTNET_API_KEY;

    if (!apiKey) {
      return res.status(500).json({
        error: "Missing PLANTNET_API_KEY in .env"
      });
    }

    const imageUrl = await uploadPlantPhotoToSupabase(req.file);

    const form = new FormData();

    form.append("images", req.file.buffer, {
      filename: req.file.originalname || "plant.jpg",
      contentType: req.file.mimetype
    });

    form.append("organs", "leaf");

    const plantnetUrl =
      `https://my-api.plantnet.org/v2/identify/all?api-key=${apiKey}`;

    const response = await fetch(plantnetUrl, {
      method: "POST",
      body: form
    });

    if (!response.ok) {
      const errorText = await response.text();
      return res.status(response.status).json({
        error: "PlantNet API error",
        detail: errorText
      });
    }

    const data = await response.json();
    const best = data.results?.[0];

    if (!best) {
      return res.json({
        commonName: "Unknown plant",
        scientificName: "Unknown species",
        score: 0,
        family: "",
        genus: "",
        imageUrl,
        raw: data
      });
    }

    res.json({
      commonName:
        best.species?.commonNames?.[0] ||
        best.species?.scientificNameWithoutAuthor ||
        "Unknown plant",

      scientificName:
        best.species?.scientificNameWithoutAuthor ||
        "Unknown species",

      score: best.score || 0,

      family:
        best.species?.family?.scientificNameWithoutAuthor || "",

      genus:
        best.species?.genus?.scientificNameWithoutAuthor || "",

      imageUrl,
      raw: data
    });

  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: "Server error",
      detail: error.message
    });
  }
});

app.listen(3000, () => {
  console.log("Plant identification server running on http://localhost:3000");
});