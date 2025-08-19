import express from "express"
import getFile from "../controllers/supabase.controller.js"
const supabaseRoute = express.Router()

supabaseRoute.post("/getFile",getFile)

export default supabaseRoute