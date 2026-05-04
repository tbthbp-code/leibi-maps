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
app.get("/test-route", (req, res) => {
  res.json({ ok: true, message: "test route works" });
});

app.get("/google-route", async (req, res) => {
  try {
    const apiKey = process.env.GOOGLE_PLACES_API_KEY;

    if (!apiKey) {
      return res.status(500).json({
        error: ".env 文件中缺少 GOOGLE_PLACES_API_KEY"
      });
    }

    const {
      fromLat,
      fromLng,
      toLat,
      toLng,
      mode = "WALK"
    } = req.query;

    if (!fromLat || !fromLng || !toLat || !toLng) {
      return res.status(400).json({
        error: "缺少路线坐标参数"
      });
    }

    const travelModeMap = {
      WALK: "WALK",
      WALKING: "WALK",
      步行: "WALK",

      BICYCLE: "BICYCLE",
      BICYCLING: "BICYCLE",
      骑行: "BICYCLE",
      自行车: "BICYCLE",

      DRIVE: "DRIVE",
      DRIVING: "DRIVE",
      自驾: "DRIVE",
      开车: "DRIVE",

      TRANSIT: "TRANSIT",
      公交: "TRANSIT",
      公共交通: "TRANSIT"
    };

    const travelMode = travelModeMap[mode] || "WALK";

    const body = {
      origin: {
        location: {
          latLng: {
            latitude: Number(fromLat),
            longitude: Number(fromLng)
          }
        }
      },
      destination: {
        location: {
          latLng: {
            latitude: Number(toLat),
            longitude: Number(toLng)
          }
        }
      },
      travelMode,
      computeAlternativeRoutes: false,
      languageCode: "zh-CN",
      units: "METRIC"
    };

    if (travelMode === "DRIVE") {
      body.routingPreference = "TRAFFIC_AWARE";
    }

    const response = await fetch(
      "https://routes.googleapis.com/directions/v2:computeRoutes",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": apiKey,
          "X-Goog-FieldMask":
            "routes.duration,routes.distanceMeters,routes.polyline.encodedPolyline"
        },
        body: JSON.stringify(body)
      }
    );

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({
        error: "Google Routes API error",
        detail: data
      });
    }

    const route = data.routes?.[0];

    if (!route) {
      return res.status(404).json({
        error: "没有找到路线"
      });
    }

    res.json({
      mode: travelMode,
      duration: route.duration,
      distanceMeters: route.distanceMeters,
      encodedPolyline: route.polyline?.encodedPolyline
    });
  } catch (error) {
    console.error("Google route error:", error);

    res.status(500).json({
      error: error.message || "路线接口失败"
    });
  }
});

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
  try {
    const {
      lng,
      lat,
      userId,
      placeName,
      placeAddress,
      placeId,
      placeType
    } = req.body;

    const id = `pending-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const { data, error } = await supabase
      .from("pending_claims")
      .insert({
        id,
        lng,
        lat,
        radius_m: 80,
        status: "pending",
        user_id: userId,
        place_name: placeName || "Unnamed botanical claim",
        place_address: placeAddress || "",
        place_id: placeId || "",
        place_type: placeType || "google_place"
      })
      .select()
      .single();

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
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
    time: new Date(record.created_at).toLocaleString(),

    isChinese: record.is_chinese,
    isAsian: record.is_asian,
    isUkNative: record.is_uk_native,
    isNonUkNative: record.is_non_uk_native,
    colonisationEffective: record.colonisation_effective,
    originConfidence: record.origin_confidence,
    originSource: record.origin_source,
    originRegions: record.origin_regions || [],
    originTaxonRemarks: record.origin_taxon_remarks || ""
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
  image_url: plant.imageUrl || null,

  is_chinese: plant.isChinese ?? plant.origin?.isChinese ?? null,
  is_asian: plant.isAsian ?? plant.origin?.isAsian ?? null,
  is_uk_native: plant.isUkNative ?? plant.origin?.isUkNative ?? null,
  is_non_uk_native: plant.isNonUkNative ?? plant.origin?.isNonUkNative ?? null,
  colonisation_effective:
    plant.colonisationEffective ?? plant.origin?.colonisationEffective ?? null,
  origin_confidence: plant.origin?.confidence || null,
  origin_source: plant.origin?.source || null,
  origin_regions: plant.origin?.locations || [],
  origin_taxon_remarks: plant.origin?.taxonRemarks || ""
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
  time: new Date(data.created_at).toLocaleString(),

  isChinese: data.is_chinese,
  isAsian: data.is_asian,
  isUkNative: data.is_uk_native,
  isNonUkNative: data.is_non_uk_native,
  colonisationEffective: data.colonisation_effective,
  originConfidence: data.origin_confidence,
  originSource: data.origin_source,
  originRegions: data.origin_regions || [],
  originTaxonRemarks: data.origin_taxon_remarks || ""
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
app.get("/google-places", async (req, res) => {
  try {
    const query = req.query.q;

    if (!query) {
      return res.status(400).json({ error: "Missing search query" });
    }

    const apiKey = process.env.GOOGLE_PLACES_API_KEY;

    if (!apiKey) {
      return res.status(500).json({
        error: "Missing GOOGLE_PLACES_API_KEY in .env"
      });
    }

    const response = await fetch("https://places.googleapis.com/v1/places:searchText", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask": "places.id,places.displayName,places.formattedAddress,places.location,places.types"
      },
      body: JSON.stringify({
        textQuery: query,
        languageCode: "zh-CN",
        locationBias: {
          circle: {
            center: {
              latitude: 51.5072,
              longitude: -0.1276
            },
            radius: 50000
          }
        }
      })
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({
        error: "Google Places API error",
        detail: data
      });
    }

    const places = (data.places || [])
      .map(place => ({
        id: place.id,
        name: place.displayName?.text || "Unnamed place",
        address: place.formattedAddress || "",
        lng: place.location?.longitude,
        lat: place.location?.latitude,
        types: place.types || [],
        source: "google"
      }))
      .filter(place => place.lng && place.lat);

    res.json(places);
  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: "Server error",
      detail: error.message
    });
  }
});

app.get("/test-powo-origin", async (req, res) => {
  try {
    const scientificName = req.query.name;

    if (!scientificName) {
      return res.status(400).json({
        error: "Missing plant scientific name"
      });
    }

    const searchUrl = `https://powo.science.kew.org/api/2/search?q=${encodeURIComponent(scientificName)}`;

    const searchResponse = await fetch(searchUrl);

    if (!searchResponse.ok) {
      const errorText = await searchResponse.text();

      return res.status(searchResponse.status).json({
        error: "POWO API error",
        detail: errorText
      });
    }

    const searchData = await searchResponse.json();

    res.json({
      scientificName,
      powoSearchResult: searchData
    });
  } catch (error) {
    console.error("POWO test error:", error);

    res.status(500).json({
      error: "POWO test failed",
      detail: error.message
    });
  }
});

app.get("/test-powo-lookup", async (req, res) => {
  try {
    const scientificName = req.query.name;

    if (!scientificName) {
      return res.status(400).json({
        error: "Missing plant scientific name"
      });
    }

    const searchUrl = `https://powo.science.kew.org/api/2/search?q=${encodeURIComponent(scientificName)}`;

    const searchResponse = await fetch(searchUrl);

    if (!searchResponse.ok) {
      const errorText = await searchResponse.text();

      return res.status(searchResponse.status).json({
        error: "POWO search API error",
        detail: errorText
      });
    }

    const searchData = await searchResponse.json();

    const firstAccepted =
      searchData.results?.find(item => item.accepted === true) ||
      searchData.results?.[0];

    if (!firstAccepted) {
      return res.status(404).json({
        error: "No POWO result found",
        searchData
      });
    }

    const fqId = firstAccepted.fqId;

    if (!fqId) {
      return res.status(404).json({
        error: "POWO result has no fqId",
        firstAccepted
      });
    }

    const lookupUrl = `https://powo.science.kew.org/api/2/taxon/${encodeURIComponent(fqId)}`;

    const lookupResponse = await fetch(lookupUrl);

    if (!lookupResponse.ok) {
      const errorText = await lookupResponse.text();

      return res.status(lookupResponse.status).json({
        error: "POWO lookup API error",
        lookupUrl,
        detail: errorText
      });
    }

    const lookupData = await lookupResponse.json();

    res.json({
      scientificName,
      matchedName: firstAccepted.name,
      fqId,
      lookupData
    });
  } catch (error) {
    console.error("POWO lookup test error:", error);

    res.status(500).json({
      error: "POWO lookup test failed",
      detail: error.message
    });
  }
});

function normalisePowoText(value) {
  return JSON.stringify(value || "").toLowerCase();
}

function classifyPowoOrigin(lookupData) {
  const text = normalisePowoText({
    locations: lookupData.locations || [],
    taxonRemarks: lookupData.taxonRemarks || "",
    native: lookupData.native || lookupData.natives || null,
    introduced: lookupData.introduced || null
  });

  const isChinese =
    text.includes("china") ||
    text.includes("chinese") ||
    text.includes("chn_") ||
    text.includes("chs_") ||
    text.includes("chc_");

  const isAsian =
    isChinese ||
    text.includes("japan") ||
    text.includes("jap_") ||
    text.includes("korea") ||
    text.includes("kor_") ||
    text.includes("taiwan") ||
    text.includes("india") ||
    text.includes("vietnam") ||
    text.includes("thailand") ||
    text.includes("asia") ||
    text.includes("eastern_asia") ||
    text.includes("southeastern_asia") ||
    text.includes("malesia") ||
    text.includes("indochina");

  const isUkRelated =
    text.includes("great britain") ||
    text.includes("united kingdom") ||
    text.includes("britain") ||
    text.includes("gbr") ||
    text.includes("england") ||
    text.includes("scotland") ||
    text.includes("wales");

  return {
    isChinese,
    isAsian,
    isUkNative: isUkRelated,
    isNonUkNative: !isUkRelated,
    colonisationEffective: !isUkRelated,
    confidence: "prototype-estimate",
    source: "POWO"
  };
}

async function getPlantOriginFromPowo(scientificName) {
  if (!scientificName || scientificName === "Unknown species") {
    return {
      isChinese: false,
      isAsian: false,
      isUkNative: null,
      isNonUkNative: null,
      colonisationEffective: null,
      confidence: "unknown",
      source: "POWO",
      locations: [],
      taxonRemarks: ""
    };
  }

  const searchUrl = `https://powo.science.kew.org/api/2/search?q=${encodeURIComponent(scientificName)}`;
  const searchResponse = await fetch(searchUrl);

  if (!searchResponse.ok) {
    throw new Error(`POWO search failed: ${searchResponse.status}`);
  }

  const searchData = await searchResponse.json();

  const firstAccepted =
    searchData.results?.find(item => item.accepted === true) ||
    searchData.results?.[0];

  if (!firstAccepted?.fqId) {
    return {
      isChinese: false,
      isAsian: false,
      isUkNative: null,
      isNonUkNative: null,
      colonisationEffective: null,
      confidence: "not-found",
      source: "POWO",
      locations: [],
      taxonRemarks: ""
    };
  }

  const lookupUrl = `https://powo.science.kew.org/api/2/taxon/${encodeURIComponent(firstAccepted.fqId)}`;
  const lookupResponse = await fetch(lookupUrl);

  if (!lookupResponse.ok) {
    throw new Error(`POWO lookup failed: ${lookupResponse.status}`);
  }

  const lookupData = await lookupResponse.json();
  const classification = classifyPowoOrigin(lookupData);

  return {
    ...classification,
    matchedName: firstAccepted.name,
    family: lookupData.family || firstAccepted.family || "",
    genus: lookupData.genus || "",
    locations: lookupData.locations || [],
    taxonRemarks: lookupData.taxonRemarks || ""
  };
}

app.get("/classify-plant-origin", async (req, res) => {
  try {
    const scientificName = req.query.name;

    if (!scientificName) {
      return res.status(400).json({
        error: "Missing plant scientific name"
      });
    }

    const searchUrl = `https://powo.science.kew.org/api/2/search?q=${encodeURIComponent(scientificName)}`;
    const searchResponse = await fetch(searchUrl);

    if (!searchResponse.ok) {
      const errorText = await searchResponse.text();

      return res.status(searchResponse.status).json({
        error: "POWO search API error",
        detail: errorText
      });
    }

    const searchData = await searchResponse.json();

    const firstAccepted =
      searchData.results?.find(item => item.accepted === true) ||
      searchData.results?.[0];

    if (!firstAccepted?.fqId) {
      return res.status(404).json({
        error: "No accepted POWO result found",
        scientificName
      });
    }

    const lookupUrl = `https://powo.science.kew.org/api/2/taxon/${encodeURIComponent(firstAccepted.fqId)}`;
    const lookupResponse = await fetch(lookupUrl);

    if (!lookupResponse.ok) {
      const errorText = await lookupResponse.text();

      return res.status(lookupResponse.status).json({
        error: "POWO lookup API error",
        detail: errorText
      });
    }

    const lookupData = await lookupResponse.json();
    const classification = classifyPowoOrigin(lookupData);

    res.json({
      scientificName,
      matchedName: firstAccepted.name,
      family: lookupData.family || firstAccepted.family || "",
      genus: lookupData.genus || "",
      taxonRemarks: lookupData.taxonRemarks || "",
      locations: lookupData.locations || [],
      classification
    });
  } catch (error) {
    console.error("Plant origin classification error:", error);

    res.status(500).json({
      error: "Plant origin classification failed",
      detail: error.message
    });
  }
});

app.get("/google-place-nearby", async (req, res) => {
  try {
    const lat = Number(req.query.lat);
    const lng = Number(req.query.lng);

    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return res.status(400).json({
        error: "Missing or invalid lat/lng"
      });
    }

    const apiKey = process.env.GOOGLE_PLACES_API_KEY;

    if (!apiKey) {
      return res.status(500).json({
        error: "Missing GOOGLE_PLACES_API_KEY"
      });
    }

    const response = await fetch("https://places.googleapis.com/v1/places:searchNearby", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask": [
          "places.id",
          "places.displayName",
          "places.formattedAddress",
          "places.location",
          "places.types",
          "places.primaryType",
          "places.rating"
        ].join(",")
      },
      body: JSON.stringify({
        languageCode: "zh-CN",
        locationRestriction: {
          circle: {
            center: {
              latitude: lat,
              longitude: lng
            },
            radius: 120
          }
        },
        rankPreference: "DISTANCE"
      })
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({
        error: "Google Places Nearby API error",
        detail: data
      });
    }

    const rawPlaces = data.places || [];

    const places = rawPlaces
      .map(place => ({
        id: place.id,
        name: place.displayName?.text || "Unnamed place",
        address: place.formattedAddress || "",
        lng: place.location?.longitude,
        lat: place.location?.latitude,
        types: place.types || [],
        primaryType: place.primaryType || "",
        rating: place.rating || null,
        source: "google-nearby"
      }))
      .filter(place => place.lng && place.lat && place.name && place.name !== "Unnamed place");

    const priorityTypes = [
      "tourist_attraction",
      "park",
      "point_of_interest",
      "establishment",
      "university",
      "school",
      "premise",
      "street_address",
      "route",
      "neighborhood"
    ];

    places.sort((a, b) => {
      const aIndex = priorityTypes.findIndex(type => a.types.includes(type) || a.primaryType === type);
      const bIndex = priorityTypes.findIndex(type => b.types.includes(type) || b.primaryType === type);

      const aScore = aIndex === -1 ? 999 : aIndex;
      const bScore = bIndex === -1 ? 999 : bIndex;

      return aScore - bScore;
    });

    res.json({
      place: places[0] || null,
      places
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: "Server error",
      detail: error.message
    });
  }
});

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

    const commonName =
  best.species?.commonNames?.[0] ||
  best.species?.scientificNameWithoutAuthor ||
  "Unknown plant";

const scientificName =
  best.species?.scientificNameWithoutAuthor ||
  "Unknown species";

const family =
  best.species?.family?.scientificNameWithoutAuthor || "";

const genus =
  best.species?.genus?.scientificNameWithoutAuthor || "";

let origin = {
  isChinese: false,
  isAsian: false,
  isUkNative: null,
  isNonUkNative: null,
  colonisationEffective: null,
  confidence: "unknown",
  source: "POWO",
  locations: [],
  taxonRemarks: ""
};

try {
  origin = await getPlantOriginFromPowo(scientificName);
} catch (originError) {
  console.error("POWO origin lookup failed:", originError.message);
}

res.json({
  commonName,
  scientificName,
  score: best.score || 0,
  family,
  genus,
  imageUrl,

  origin,

  isChinese: origin.isChinese,
  isAsian: origin.isAsian,
  isUkNative: origin.isUkNative,
  isNonUkNative: origin.isNonUkNative,
  colonisationEffective: origin.colonisationEffective,

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