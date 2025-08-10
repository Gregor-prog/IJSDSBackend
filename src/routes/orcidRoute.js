import express from "express"
import orcidAuth from "../controllers/orcid.controller.js"
const router = express.Router()

router.post("/orcid/:code",orcidAuth)

export default router