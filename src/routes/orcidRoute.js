import express from "express"
import orcidAuth from "../controllers/orcid.controller.js"
const router = express.Router()

router.get("/orcid",orcidAuth)
// router.get("/orcid")

export default router