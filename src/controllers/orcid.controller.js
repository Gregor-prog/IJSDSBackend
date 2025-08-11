import express from "express"
import getAccessCode from "../services/orcid.service.js"

const orcidAuth = async (req,res) => {
    try {
        const code  = req.query.code
        const accessCode = await getAccessCode(code)
        res.status(200).json({
            success:true,
            message:"sign in successfull",
            data:accessCode
        })
    } catch (error) {
        if(error){
            res.status(404).json({
                success:false,
                message:"an error occured, couldn't sign in",
                data:error.message
            })
        }
    }
}

export default orcidAuth