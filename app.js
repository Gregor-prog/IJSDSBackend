import express from "express"
import "dotenv/config"
import router from "./src/routes/orcidRoute.js"

const app = express()

//middlewares
app.use(express.json())
// app.use(cors)
app.use("/auth",router)


export default app
// app.listen(4500)