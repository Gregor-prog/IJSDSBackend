import express from "express"
import paystackController from "../controllers/paystack.controller.js"

const paystackRoute = express.Router()
paystackRoute.post("/verify-payment",paystackController)

export default paystackRoute