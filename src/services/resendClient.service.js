import {Resend} from "resend"

const resend = new Resend(process.env.RESEND_API_KEY)

const sendEmail = async (emailData) => {
    const body = `<p>Hi ${emailData.name},</p>

    <p>Welcome to the International Journal for Social Work and Development Studies (IJSDS) — we’re glad you’re here.</p>

    <p>To kick off the review process, a <strong>₦5,000 vetting fee</strong> is required. This covers our initial checks (scope, formatting, and basic quality screening).</p>

    <p>If your article is accepted after peer review, a <strong>₦20,000 processing fee</strong> will apply before publication.</p>

    <p>Questions, refund policy, or want us to check one last citation for you? Reply to this email or contact: 
    <a href="mailto:editor@ijsds.org">editor@ijsds.org</a>.</p>

    <p>Welcome aboard — let’s get your research seen. ✨</p>

    <p>Warmly,<br/>
    <em>Editorial Team</em><br/>
    International Journal for Social Work and Development Studies</p>
  `;
    try {
        await resend.emails.send({
        from :"IJSDS <noreply@ijsds.org>",
        to:emailData.to,
        subject:'Welcome to IJSDS — Submission & Fee Information',
        html:body
    })
    } catch (error) {
        if(error) throw error
    }
    console.log("this function ran")
}

export default sendEmail