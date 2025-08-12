import express from "express"
import getAccessCode from "../services/orcid.service.js"
import userProfile from "../services/accessToken.service.js"
import authUser from "../services/authenticteUser.service.js"

const orcidAuth = async (req,res) => {
    let magiclink = null
    try {
        // getting code from orcid
        const code  = req.query.code
        // getting access tokekn
        const orcidData = await getAccessCode(code)
        //getting user data
        const userData = await userProfile(orcidData)

             console.log(orcidData)
        console.log(userData)

        const orcid = orcidData.orcid
        const name = orcidData.name
        const email = userData.emails?.email[0].email
        console.log(email)

   
        
        const magiclink = await authUser(name,email,orcid)

        // res.status(200).json({
        //     success:true,
        //     message:"sign in successful",
        //     data:userData
        // })
        res.redirect(magiclink)
    } catch (error) {
        // if(typeof magiclink != "undefined"  && magiclink !== null && magiclink ){
        //         res.redirect(magiclink)
        //     }
            console.log(error)
            res.status(404).json({
                success:false,
                message:"an error occured, couldn't sign in",
                data:error.message
            })
    }
}

export default orcidAuth